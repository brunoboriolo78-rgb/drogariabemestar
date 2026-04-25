// ============================================================
//  WEBHOOK — RecorrênciaFarma
//  Integração: Z-API (WhatsApp) + Claude API (Agente Bia)
//  Runtime: Node.js 18+
//  Instalar: npm install express @anthropic-ai/sdk @supabase/supabase-js dotenv
// ============================================================

require('dotenv').config();
const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
app.use(express.json());

// ─── CLIENTES DE API ─────────────────────────────────────────
const claude   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─── CARREGAR SYSTEM PROMPT ──────────────────────────────────
const fs = require('fs');
const BASE_SYSTEM_PROMPT = fs.readFileSync('./system_prompt.txt', 'utf8');

// ─── HISTÓRICO DE CONVERSA (em memória — prod: use Redis/Supabase) ────
const conversas = new Map(); // whatsapp -> [ {role, content}, ... ]

// ============================================================
//  ENDPOINT PRINCIPAL — recebe mensagens do WhatsApp (Z-API)
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { phone, text, isGroup } = req.body; const message = { text: text?.message };

    // Ignora grupos e mensagens de status
    if (isGroup || !message?.text) {
      return res.status(200).json({ ok: true });
    }

    const whatsapp    = phone.replace(/\D/g, '');
    const textoCliente = message.text.trim();

    console.log(`[MENSAGEM] ${whatsapp}: "${textoCliente}"`);

    // 1. Busca contexto do cliente no banco
    const contexto = await buscarContextoCliente(whatsapp);
    if (!contexto) {
      console.log(`[INFO] Cliente ${whatsapp} não encontrado no banco. Ignorando.`);
      return res.status(200).json({ ok: true });
    }

    // 2. Verifica se cliente está em opt-out
    if (contexto.opt_out) {
      console.log(`[INFO] Cliente ${whatsapp} em opt-out. Ignorando.`);
      return res.status(200).json({ ok: true });
    }

    // 3. Monta histórico da conversa
    if (!conversas.has(whatsapp)) {
      conversas.set(whatsapp, []);
    }
    const historico = conversas.get(whatsapp);
    historico.push({ role: 'user', content: textoCliente });

    // 4. Monta system prompt personalizado com dados do cliente
    const systemPrompt = montarSystemPrompt(contexto);

    // 5. Chama o agente Bia via Claude API
    const resposta = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: historico.slice(-10), // mantém últimas 10 mensagens
    });

    const textoResposta = resposta.content[0].text;

    // 6. Processa sinais de ação do agente
    await processarSinais(textoResposta, contexto, whatsapp);

    // 7. Limpa a resposta (remove blocos internos antes de enviar)
    const respostaLimpa = limparResposta(textoResposta);

    // 8. Adiciona resposta ao histórico
    historico.push({ role: 'assistant', content: respostaLimpa });

    // 9. Envia mensagem via Z-API
    await enviarWhatsApp(whatsapp, respostaLimpa, contexto.farmacia_whatsapp_token);

    console.log(`[RESPOSTA] → ${whatsapp}: "${respostaLimpa.substring(0, 80)}..."`);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[ERRO] webhook:', err);
    return res.status(500).json({ erro: err.message });
  }
});

// ============================================================
//  ENDPOINT — disparar alerta do dia (chamado pelo cron/scheduler)
// ============================================================
app.post('/webhook/disparar-alertas', async (req, res) => {
  try {
    // Busca todos os alertas do dia na view do banco
    const { data: alertas, error } = await supabase
      .from('vw_alertas_hoje')
      .select('*');

    if (error) throw error;

    console.log(`[CRON] ${alertas.length} alertas para disparar hoje`);

    let enviados = 0;
    let erros    = 0;

    for (const alerta of alertas) {
      try {
        const mensagem = montarMensagemInicial(alerta);

        // Envia via Z-API
        await enviarWhatsApp(
          alerta.cliente_whatsapp,
          mensagem,
          alerta.whatsapp_token
        );

        // Registra no banco
        await supabase.rpc('registrar_alerta_enviado', {
          p_compra_id: alerta.compra_id,
          p_mensagem:  mensagem,
        });

        // Inicializa histórico de conversa com mensagem enviada
        conversas.set(alerta.cliente_whatsapp, [
          { role: 'assistant', content: mensagem }
        ]);

        enviados++;
        console.log(`[OK] Alerta enviado → ${alerta.cliente_nome} (${alerta.cliente_whatsapp})`);

        // Pausa 1s entre envios para não ser bloqueado
        await sleep(1000);

      } catch (e) {
        erros++;
        console.error(`[ERRO] Falha ao enviar para ${alerta.cliente_whatsapp}:`, e.message);
      }
    }

    return res.status(200).json({
      total: alertas.length,
      enviados,
      erros,
    });

  } catch (err) {
    console.error('[ERRO] disparar-alertas:', err);
    return res.status(500).json({ erro: err.message });
  }
});

// ============================================================
//  FUNÇÕES AUXILIARES
// ============================================================

// Busca dados do cliente e compra ativa pelo WhatsApp
async function buscarContextoCliente(whatsapp) {
  const { data, error } = await supabase
    .from('vw_alertas_hoje')
    .select('*')
    .eq('cliente_whatsapp', whatsapp)
    .single();

  if (error || !data) return null;
  return data;
}

// Monta o system prompt com os dados reais do cliente
function montarSystemPrompt(ctx) {
  return BASE_SYSTEM_PROMPT
    .replace(/{FARMACIA_NOME}/g,      ctx.farmacia_nome      || 'Farmácia')
    .replace(/{FARMACIA_TELEFONE}/g,  ctx.farmacia_telefone  || '')
    .replace(/{FARMACIA_HORARIO}/g,   ctx.farmacia_horario   || 'Seg–Sex 8h–19h, Sáb 8h–13h')
    .replace(/{CLIENTE_NOME}/g,       ctx.cliente_nome       || 'Cliente')
    .replace(/{MEDICAMENTO_NOME}/g,   ctx.medicamento_nome   || 'medicamento')
    .replace(/{MEDICAMENTO_TIPO}/g,   ctx.medicamento_tipo   || 'comum')
    .replace(/{DIAS_RESTANTES}/g,     String(ctx.dias_restantes || 2))
    .replace(/{DATA_FIM}/g,           formatarData(ctx.data_fim))
    .replace(/{COMPRA_ID}/g,          ctx.compra_id          || '');
}

// Monta a mensagem inicial do alerta automático
function montarMensagemInicial(ctx) {
  const nome = ctx.cliente_nome.split(' ')[0]; // só o primeiro nome
  const dias = ctx.dias_restantes;
  const med  = ctx.medicamento_nome;
  const data = formatarData(ctx.data_fim);
  const farmacia = ctx.farmacia_nome;

  if (ctx.requer_receita) {
    return `Oi, ${nome}! 👋\n\nAqui é a Bia, da ${farmacia}.\nSeu *${med}* vai acabar em *${dias} dia${dias>1?'s':''}* (${data}).\n\nQuer que eu já reserve pra você? Só lembra de trazer a receita atualizada 📋\n\nResponde *SIM* pra reservar ou *NÃO* se não precisar.`;
  }

  return `Oi, ${nome}! 👋\n\nAqui é a Bia, da ${farmacia}.\nSeu *${med}* vai acabar em *${dias} dia${dias>1?'s':''}* (${data}).\n\nQuer que eu já separe uma caixinha pra você? 💊\n\nResponde *SIM* pra reservar ou *NÃO* se não precisar.`;
}

// Processa os sinais de ação emitidos pelo agente
async function processarSinais(texto, ctx, whatsapp) {

  // SINAL: recompra confirmada
  if (texto.includes('[[CONVERSAO]]')) {
    console.log(`[CONVERSAO] Recompra confirmada — ${ctx.cliente_nome}`);
    await supabase.rpc('registrar_recompra', {
      p_alerta_id:     null,
      p_compra_origem: ctx.compra_id,
    });
  }

  // SINAL: transferir para humano
  if (texto.includes('[[TRANSFERIR_HUMANO]]')) {
    console.log(`[TRANSFERENCIA] → ${ctx.cliente_nome} (${whatsapp})`);
    // Aqui você notifica o atendente (Slack, email, sistema interno, etc.)
    await notificarAtendente(ctx, whatsapp);
  }

  // SINAL: cancelar alertas (opt-out)
  if (texto.includes('[[CANCELAR_ALERTAS]]')) {
    console.log(`[OPT-OUT] ${ctx.cliente_nome} cancelou alertas`);
    await supabase
      .from('clientes')
      .update({ ativo: false })
      .eq('whatsapp', whatsapp);
  }
}

// Remove blocos internos antes de enviar para o cliente
function limparResposta(texto) {
  return texto
    .replace(/\[\[CONVERSAO\]\][\s\S]*?\[\[\/CONVERSAO\]\]/g, '')
    .replace(/\[\[TRANSFERIR_HUMANO\]\]/g, '')
    .replace(/\[\[CANCELAR_ALERTAS\]\]/g, '')
    .trim();
}

// Envia mensagem via Z-API
async function enviarWhatsApp(whatsapp, texto, token) {
  const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
  const ZAPI_TOKEN    = token || process.env.ZAPI_TOKEN_PADRAO;

  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': 'F99c7b86398234011812f7525b76f2446S', 'Client-Token': 'F99c7b86398234011812f7525b76f2446S' },
    body: JSON.stringify({
      phone:   whatsapp,
      message: texto,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Z-API erro: ${resp.status} — ${err}`);
  }

  return resp.json();
}

// Notifica atendente humano (personalize aqui — Slack, email, etc.)
async function notificarAtendente(ctx, whatsapp) {
  // Exemplo: enviar mensagem no Slack
  // await fetch(process.env.SLACK_WEBHOOK_URL, {
  //   method: 'POST',
  //   body: JSON.stringify({
  //     text: `🔔 Cliente ${ctx.cliente_nome} (${whatsapp}) precisa de atendimento humano!`
  //   })
  // });
  console.log(`[TODO] Notificar atendente sobre ${ctx.cliente_nome} (${whatsapp})`);
}

// Formata data para pt-BR
function formatarData(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('pt-BR');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ RecorrênciaFarma webhook rodando na porta ${PORT}`);
  console.log(`   POST /webhook/whatsapp       ← recebe mensagens`);
  console.log(`   POST /webhook/disparar-alertas ← dispara alertas do dia`);
});
