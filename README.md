# 💊 RecorrênciaFarma

**SaaS de recorrência automática para farmácias via WhatsApp + IA**

Quando o remédio do cliente está acabando, o sistema detecta automaticamente e envia uma mensagem personalizada via WhatsApp. A Bia — agente de IA — continua a conversa, confirma a recompra e registra a conversão. Tudo sem intervenção humana.

---

## 🏗️ Estrutura do projeto

```
recorrencia-farma/
├── README.md
├── database/
│   └── schema.sql              # Banco de dados completo (Supabase)
├── dashboard/
│   └── index.html              # Dashboard da farmácia (HTML puro)
└── agent/
    ├── system_prompt.txt       # System prompt do agente Bia (Claude)
    ├── fluxo_conversa.md       # Todos os cenários de conversa mapeados
    ├── zapi_webhook.js         # Servidor Node.js — integração Z-API + Claude
    ├── package.json            # Dependências Node.js
    └── .env.example            # Variáveis de ambiente necessárias
```

---

## ⚙️ Como funciona

```
[Banco Supabase]
  └─ pg_cron roda todo dia às 08h
       └─ busca compras com data_alerta = hoje (vw_alertas_hoje)
            └─ POST /webhook/disparar-alertas
                 └─ Z-API envia mensagem personalizada via WhatsApp
                      └─ Cliente responde
                           └─ POST /webhook/whatsapp
                                └─ Claude API (agente Bia) responde
                                     └─ Se SIM → registra recompra no banco
                                     └─ Se precisar humano → notifica atendente
```

---

## 🚀 Setup em 4 passos

### 1. Banco de dados (Supabase)

1. Crie um projeto gratuito em [supabase.com](https://supabase.com)
2. Abra o **SQL Editor**
3. Cole o conteúdo de `database/schema.sql` e clique **Run**
4. Copie a **URL** e a **anon key** do projeto (Settings → API)

### 2. WhatsApp (Z-API)

1. Crie uma conta em [z-api.io](https://z-api.io)
2. Crie uma instância e escaneie o QR Code com seu WhatsApp
3. Copie o **Instance ID** e o **Token**

### 3. Webhook (Node.js)

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/recorrencia-farma.git
cd recorrencia-farma/agent

# Instale as dependências
npm install

# Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas chaves

# Rode localmente (desenvolvimento)
npm run dev

# Para expor localmente use ngrok:
# ngrok http 3000
```

### 4. Configurar o cron no Supabase

No **SQL Editor** do Supabase, ative o pg_cron:

```sql
-- Habilitar extensão (só uma vez)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Criar job: dispara alertas todo dia às 08h (horário UTC-3 = 11h UTC)
SELECT cron.schedule(
  'disparar-alertas-diarios',
  '0 11 * * *',
  $$
  SELECT net.http_post(
    url := 'https://sua-url.railway.app/webhook/disparar-alertas',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
```

> **Nota:** Substitua `sua-url.railway.app` pela URL real do seu servidor.

---

## 🔑 Variáveis de ambiente necessárias

| Variável | Onde encontrar |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_KEY` | Supabase → Settings → API (anon key) |
| `ZAPI_INSTANCE` | Painel Z-API → sua instância |
| `ZAPI_TOKEN_PADRAO` | Painel Z-API → Token |

---

## 🌐 Deploy (produção)

**Recomendado: Railway** (gratuito para começar)

1. Crie conta em [railway.app](https://railway.app)
2. Conecte o repositório GitHub
3. Defina as variáveis de ambiente no painel do Railway
4. O deploy é automático a cada push

**Alternativa: Render, Fly.io, ou VPS própria**

---

## 📊 Dashboard

Abra `dashboard/index.html` diretamente no navegador para ver o painel.

> **Versão atual:** frontend estático com dados demo.  
> **Próxima versão:** conectado ao Supabase via JS SDK.

---

## 🗺️ Roadmap

- [x] Banco de dados com alertas automáticos
- [x] Dashboard visual para a farmácia
- [x] Agente de IA (Bia) para WhatsApp
- [x] Webhook Z-API + Claude API
- [ ] Dashboard conectado ao Supabase (real-time)
- [ ] Multi-farmácia (tenant por subdomínio)
- [ ] Integração com sistema de PDV
- [ ] App mobile para o farmacêutico
- [ ] Relatórios mensais automáticos por email

---

## 💰 Modelo de negócio

| Plano | Preço | Clientes | Alertas/mês |
|---|---|---|---|
| Básico | R$ 197/mês | até 200 | até 500 |
| Pro | R$ 397/mês | até 1.000 | ilimitados |
| Enterprise | sob consulta | ilimitado | ilimitados + integração PDV |

---

## 🛠️ Stack

- **Banco:** Supabase (PostgreSQL + pg_cron)
- **Backend:** Node.js + Express
- **IA:** Claude API (Anthropic) — modelo Sonnet
- **WhatsApp:** Z-API
- **Frontend:** HTML + CSS + JS puro (sem framework)
- **Deploy:** Railway

---

## 📄 Licença

MIT — use, modifique e venda à vontade.

---

*Construído com Claude — [anthropic.com](https://anthropic.com)*
