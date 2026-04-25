-- ============================================================
--  SAAS FARMÁCIA RECORRENTE — Schema completo Supabase
--  Cole este arquivo inteiro no SQL Editor do Supabase
--  e clique em "Run"
-- ============================================================

-- --------------------------------
-- 1. FARMACIAS (cada cliente do SaaS)
-- --------------------------------
CREATE TABLE farmacias (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          TEXT NOT NULL,
  telefone      TEXT,
  whatsapp_token TEXT,              -- token da Z-API ou Evolution API
  dias_alerta   INT  NOT NULL DEFAULT 2, -- quantos dias antes de acabar alertar
  plano         TEXT NOT NULL DEFAULT 'basico', -- basico | pro | enterprise
  ativo         BOOLEAN NOT NULL DEFAULT true,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------
-- 2. CLIENTES (pacientes da farmácia)
-- --------------------------------
CREATE TABLE clientes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmacia_id  UUID NOT NULL REFERENCES farmacias(id) ON DELETE CASCADE,
  nome         TEXT NOT NULL,
  whatsapp     TEXT NOT NULL,       -- formato: 5511999999999
  cpf          TEXT,
  email        TEXT,
  ativo        BOOLEAN NOT NULL DEFAULT true,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(farmacia_id, whatsapp)     -- mesmo cliente não entra duplicado
);

-- --------------------------------
-- 3. MEDICAMENTOS (catálogo da farmácia)
-- --------------------------------
CREATE TABLE medicamentos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmacia_id     UUID NOT NULL REFERENCES farmacias(id) ON DELETE CASCADE,
  nome            TEXT NOT NULL,
  principio_ativo TEXT,
  tipo            TEXT DEFAULT 'comum', -- comum | controlado | tarja_preta
  requer_receita  BOOLEAN NOT NULL DEFAULT false,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------
-- 4. COMPRAS (tabela central — o coração do sistema)
-- --------------------------------
CREATE TABLE compras (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id        UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  medicamento_id    UUID NOT NULL REFERENCES medicamentos(id),
  farmacia_id       UUID NOT NULL REFERENCES farmacias(id),  -- denormalizado para queries rápidas
  data_compra       DATE NOT NULL DEFAULT CURRENT_DATE,
  duracao_dias      INT  NOT NULL,           -- ex: 30 (dias que o remédio dura)
  quantidade        INT  NOT NULL DEFAULT 1, -- caixas compradas
  data_fim          DATE GENERATED ALWAYS AS (data_compra + duracao_dias) STORED,
  data_alerta       DATE GENERATED ALWAYS AS (data_compra + duracao_dias - (
                      SELECT dias_alerta FROM farmacias WHERE id = farmacia_id
                    )) STORED,               -- calculado automático
  observacao        TEXT,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------
-- 5. ALERTAS (registro de cada disparo)
-- --------------------------------
CREATE TABLE alertas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id     UUID NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviado | erro | cancelado
  mensagem_enviada TEXT,                          -- texto exato que foi enviado
  resposta_cliente TEXT,                          -- o que o cliente respondeu
  enviado_em    TIMESTAMPTZ,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------
-- 6. RECOMPRAS (rastreia conversão)
-- --------------------------------
CREATE TABLE recompras (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alerta_id         UUID REFERENCES alertas(id),
  compra_origem_id  UUID NOT NULL REFERENCES compras(id), -- compra que gerou o alerta
  nova_compra_id    UUID REFERENCES compras(id),          -- nova compra gerada
  convertido        BOOLEAN NOT NULL DEFAULT false,
  convertido_em     TIMESTAMPTZ,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
--  INDEXES — deixam as queries rápidas
-- ============================================================
CREATE INDEX idx_compras_data_alerta   ON compras(data_alerta);
CREATE INDEX idx_compras_farmacia      ON compras(farmacia_id);
CREATE INDEX idx_clientes_farmacia     ON clientes(farmacia_id);
CREATE INDEX idx_alertas_status        ON alertas(status);
CREATE INDEX idx_alertas_compra        ON alertas(compra_id);

-- ============================================================
--  VIEW — alertas do dia (o que o cron vai usar todo dia)
-- ============================================================
CREATE OR REPLACE VIEW vw_alertas_hoje AS
SELECT
  c.id                AS compra_id,
  f.id                AS farmacia_id,
  f.nome              AS farmacia_nome,
  f.whatsapp_token,
  f.dias_alerta,
  cl.nome             AS cliente_nome,
  cl.whatsapp         AS cliente_whatsapp,
  m.nome              AS medicamento_nome,
  m.tipo              AS medicamento_tipo,
  m.requer_receita,
  c.data_compra,
  c.duracao_dias,
  c.data_fim,
  c.data_alerta,
  (c.data_fim - CURRENT_DATE) AS dias_restantes
FROM compras c
JOIN clientes cl    ON cl.id = c.cliente_id
JOIN medicamentos m ON m.id = c.medicamento_id
JOIN farmacias f    ON f.id = c.farmacia_id
WHERE
  c.data_alerta = CURRENT_DATE           -- só os que vencem hoje
  AND f.ativo = true
  AND cl.ativo = true
  AND NOT EXISTS (                       -- que ainda não foram alertados
    SELECT 1 FROM alertas a
    WHERE a.compra_id = c.id
    AND a.status IN ('enviado', 'cancelado')
  );

-- ============================================================
--  VIEW — dashboard da farmácia (taxa de recompra)
-- ============================================================
CREATE OR REPLACE VIEW vw_dashboard_farmacia AS
SELECT
  f.id AS farmacia_id,
  f.nome AS farmacia_nome,
  COUNT(DISTINCT cl.id)                              AS total_clientes,
  COUNT(DISTINCT c.id)                               AS total_compras,
  COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'enviado') AS alertas_enviados,
  COUNT(DISTINCT r.id) FILTER (WHERE r.convertido = true)  AS recompras_convertidas,
  ROUND(
    100.0 * COUNT(DISTINCT r.id) FILTER (WHERE r.convertido = true)
    / NULLIF(COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'enviado'), 0), 1
  ) AS taxa_recompra_pct
FROM farmacias f
LEFT JOIN clientes cl   ON cl.farmacia_id = f.id
LEFT JOIN compras c     ON c.farmacia_id  = f.id
LEFT JOIN alertas a     ON a.compra_id    = c.id
LEFT JOIN recompras r   ON r.compra_origem_id = c.id
GROUP BY f.id, f.nome;

-- ============================================================
--  FUNÇÃO — registrar alerta enviado
--  Chamada pelo backend logo após enviar o WhatsApp
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_alerta_enviado(
  p_compra_id       UUID,
  p_mensagem        TEXT
)
RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_alerta_id UUID;
BEGIN
  INSERT INTO alertas (compra_id, status, mensagem_enviada, enviado_em)
  VALUES (p_compra_id, 'enviado', p_mensagem, now())
  RETURNING id INTO v_alerta_id;

  RETURN v_alerta_id;
END;
$$;

-- ============================================================
--  FUNÇÃO — registrar recompra convertida
--  Chamada quando o cliente responde "sim" no WhatsApp
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_recompra(
  p_alerta_id       UUID,
  p_compra_origem   UUID,
  p_nova_compra_id  UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO recompras (alerta_id, compra_origem_id, nova_compra_id, convertido, convertido_em)
  VALUES (p_alerta_id, p_compra_origem, p_nova_compra_id, true, now());

  -- Atualiza resposta no alerta
  UPDATE alertas SET resposta_cliente = 'convertido' WHERE id = p_alerta_id;
END;
$$;

-- ============================================================
--  DADOS DE TESTE — rode isso para ver funcionando
-- ============================================================

-- Farmácia de exemplo
INSERT INTO farmacias (nome, telefone, dias_alerta, plano)
VALUES ('Farmácia São João', '(19) 3333-0000', 2, 'basico')
RETURNING id;

-- Cole o id retornado abaixo em <ID_FARMACIA>
-- INSERT INTO clientes (farmacia_id, nome, whatsapp)
-- VALUES ('<ID_FARMACIA>', 'João da Silva', '5519999990001');

-- INSERT INTO medicamentos (farmacia_id, nome, tipo, requer_receita)
-- VALUES ('<ID_FARMACIA>', 'Losartana 50mg', 'controlado', true);

-- Compra com vencimento em 30 dias
-- INSERT INTO compras (cliente_id, medicamento_id, farmacia_id, duracao_dias)
-- VALUES ('<ID_CLIENTE>', '<ID_MEDICAMENTO>', '<ID_FARMACIA>', 30);

-- Verifique os alertas de hoje:
-- SELECT * FROM vw_alertas_hoje;
