import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";
import cron from "node-cron";
import { z } from "zod";
import moment from "moment-timezone";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch"; // <-- necessário para baixar a imagem da fatura

dotenv.config();

const app = express();
app.use(express.json());

// =========================
// 🔌 CONEXÕES
// =========================

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const usuarios = {
  8823110547: "Emanuelly",
  1325366143: "Junior"
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =========================
// 🌐 CONFIGURAÇÃO DO WEBHOOK
// =========================
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_ID}.onrender.com`;
bot.setWebHook(`${WEBHOOK_URL}/webhook`);

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// =========================
// 📋 COMANDOS DO MENU
// =========================
(async () => {
  await bot.setMyCommands([
    { command: "start", description: "Ver todos os comandos" },
    { command: "saldo", description: "Seu saldo individual" },
    { command: "geral", description: "Saldo geral (Junior + Emanuelly)" },
    { command: "cartao", description: "Ver gastos de um cartão" },
    { command: "cartoes", description: "Listar seus cartões" },
    { command: "gasto", description: "Registrar gasto rápido" },
    { command: "receita", description: "Registrar receita rápida" },
    { command: "recorrentes", description: "Ver receitas recorrentes ativas" },
    { command: "cancelarrecorrente", description: "Cancelar uma recorrência de receita" },
    { command: "gastosrecorrentes", description: "Ver gastos recorrentes ativos" },
    { command: "cancelargastorecorrente", description: "Cancelar um gasto recorrente" }
  ]);
})();

// =========================
// 🧠 IA PROMPTS
// =========================
const PROMPT_FATURA = `
Você é um assistente financeiro. Analise a imagem de uma FATURA DE CARTÃO DE CRÉDITO.
Retorne APENAS um JSON com a lista de compras encontradas.

Formato:
{
  "compras": [
    {
      "descricao": "string",
      "valor": number,
      "parcela_info": "string",
      "categoria": "string"
    }
  ]
}

Regras:
- O valor é o valor da parcela que aparece na fatura.
- Se aparecer "3/6", parcela_info = "3/6". Se for à vista, use "1/1".
- Categorias: alimentação, transporte, saúde, farmácia, lazer, educação, moradia, serviços, compras, assinaturas, outros.
`;

const SYSTEM_PROMPT = `
Você é um assistente financeiro.

Transforme mensagens em JSON válido.

Se for gasto:
{
  "type": "gasto",
  "descricao": "",
  "categoria": "",
  "valor": number,
  "forma_pagamento": "pix | dinheiro | cartao_credito",
  "cartao": "",
  "parcelado": boolean,
  "parcelas": number,
  "recorrente": boolean,
  "dia_recorrencia": number (opcional, se recorrente)
}

Se for receita:
{
  "type": "receita",
  "descricao": "",
  "valor": number,
  "recorrente": boolean,
  "dia_recorrencia": number (opcional, se recorrente)
}

Se for consulta:
{
  "type": "consulta"
}

REGRAS:
- Se não falar pagamento → assumir "pix"
- PIX e dinheiro = "pix"
- Só usar cartão se citado explicitamente
- Parcelas: se não falar → 1
- Para gasto ou receita recorrente, extraia o dia do mês (ex: "todo dia 5" → dia_recorrencia: 5).
  Se não especificar o dia, pergunte ou assuma o dia atual.
- Um gasto NÃO pode ser ao mesmo tempo parcelado e recorrente. Se for recorrente, ignorar parcelas.
- Quando o usuário mencionar parcelas (ex: "em 3x", "parcelado"), retorne parcelado: true e parcelas: N. O campo valor deve ser o VALOR TOTAL DA COMPRA.

**CATEGORIAS (gastos):**
Analise a descrição e classifique em uma das categorias abaixo:
- alimentação (restaurante, mercado, comida, delivery, lanche...)
- transporte (gasolina, uber, ônibus, metrô, estacionamento...)
- saúde (remédio, médico, consulta, hospital, exame...)
- farmácia (farmacia, farmácia, manipulação...)
- lazer (cinema, viagem, jogos, bar, festa...)
- educação (curso, livro, faculdade, escola...)
- moradia (aluguel, condomínio, conta de luz, água, internet...)
- serviços (manicure, cabeleireiro, encanador...)
- compras (roupa, eletrônicos, eletrodomésticos...)
- assinaturas (netflix, spotify, academia...)
- outros (se não se encaixar em nenhuma)

Escolha a categoria mais adequada e preencha o campo "categoria".
Se a descrição for muito vaga, use "outros".

Responda APENAS JSON válido.
`;

// =========================
// 🧠 IA
// =========================
async function interpretar(texto) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: texto }
    ]
  });
  return JSON.parse(res.choices[0].message.content);
}

// ✅ NOVA FUNÇÃO PARA ANALISAR FATURA (IMAGEM)
async function analisarFatura(fileUrl) {
  // 1. Baixar a imagem
  const response = await fetch(fileUrl);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const contentType = "image/jpeg";

  // 2. Chamar GPT-4o-mini
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: PROMPT_FATURA },
      {
        role: "user",
        content: [
          { type: "text", text: "Extraia as compras desta fatura." },
          {
            type: "image_url",
            image_url: { url: `data:${contentType};base64,${base64}` }
          }
        ]
      }
    ],
    max_tokens: 2000,
    temperature: 0.1
  });

  // 3. Limpar e retornar JSON
  const texto = completion.choices[0].message.content
    .replace(/```json|```/g, "")
    .trim();
  return JSON.parse(texto);
}

// =========================
// ✅ VALIDAÇÃO COM ZOD
// =========================
const gastoSchema = z.object({
  type: z.literal("gasto"),
  descricao: z.string().min(1),
  categoria: z.string().default("outros"),
  valor: z.number().positive(),
  forma_pagamento: z.enum(["pix", "dinheiro", "cartao_credito"]).default("pix"),
  cartao: z.string().nullable().optional(),
  parcelado: z.boolean().default(false),
  parcelas: z.number().int().min(1).default(1),
  recorrente: z.boolean().default(false),
  dia_recorrencia: z.number().int().min(1).max(31).optional()
});

const receitaSchema = z.object({
  type: z.literal("receita"),
  descricao: z.string().min(1),
  valor: z.number().positive(),
  recorrente: z.boolean().default(false),
  dia_recorrencia: z.number().int().min(1).max(31).optional()
});

// =========================
// 📌 PENDÊNCIAS
// =========================
const pendencias = new Map();

// =========================
// 💰 SALDO INDIVIDUAL (mês atual)
// =========================
async function saldoIndividual(chatId) {
  const usuario = usuarios[chatId];
  const inicioMes = moment().tz("America/Sao_Paulo").startOf('month').toISOString();
  const fimMes = moment().tz("America/Sao_Paulo").endOf('month').toISOString();

  const { data: gastos } = await supabase
    .from("gastos")
    .select("valor")
    .eq("usuario", usuario)
    .gte("created_at", inicioMes)
    .lte("created_at", fimMes);

  const { data: receitas } = await supabase
    .from("receitas")
    .select("valor")
    .eq("usuario", usuario)
    .gte("created_at", inicioMes)
    .lte("created_at", fimMes);

  const totalGastos = (gastos || []).reduce((a, b) => a + Number(b.valor || 0), 0);
  const totalReceitas = (receitas || []).reduce((a, b) => a + Number(b.valor || 0), 0);
  return {
    gastos: totalGastos,
    receitas: totalReceitas,
    saldo: totalReceitas - totalGastos
  };
}

// =========================
// 👥 SALDO GERAL
// =========================
async function saldoGeral() {
  let resposta = `📊 SALDO GERAL\n\n`;
  let totalGastos = 0;
  let totalReceitas = 0;
  for (const [id, nome] of Object.entries(usuarios)) {
    const { data: g } = await supabase
      .from("gastos")
      .select("valor")
      .eq("usuario", nome);
    const { data: r } = await supabase
      .from("receitas")
      .select("valor")
      .eq("usuario", nome);
    const gastos = (g || []).reduce((s, i) => s + Number(i.valor || 0), 0);
    const receitas = (r || []).reduce((s, i) => s + Number(i.valor || 0), 0);
    const saldo = receitas - gastos;
    resposta += `👤 ${nome}\n📥 Receitas: R$ ${receitas.toFixed(2)}\n📤 Gastos: R$ ${gastos.toFixed(2)}\n💵 Saldo: R$ ${saldo.toFixed(2)}\n\n`;
    totalReceitas += receitas;
    totalGastos += gastos;
  }
  resposta += `💳 TOTAL CONSOLIDADO\n📥 Receitas: R$ ${totalReceitas.toFixed(2)}\n📤 Gastos: R$ ${totalGastos.toFixed(2)}\n💰 Saldo: R$ ${(totalReceitas - totalGastos).toFixed(2)}`;
  return resposta;
}

// =========================
// 💳 GASTOS POR CARTÃO
// =========================
async function gastosPorCartao(chatId, cartaoNome) {
  const usuario = usuarios[chatId];
  const { data } = await supabase
    .from("gastos")
    .select("descricao, valor, total_parcelas, parcela_numero")
    .eq("usuario", usuario)
    .eq("cartao", cartaoNome);
  if (!data || data.length === 0) {
    return `💳 Nenhum gasto encontrado no cartão ${cartaoNome}`;
  }
  let total = 0;
  const lista = data.map(g => {
    total += Number(g.valor);
    const parcelasInfo = g.total_parcelas ? ` (${g.parcela_numero}/${g.total_parcelas})` : '';
    return `• ${g.descricao} - R$ ${g.valor}${parcelasInfo}`;
  }).join("\n");
  return `💳 CARTÃO: ${cartaoNome}\n\n${lista}\n\n💰 TOTAL: R$ ${total.toFixed(2)}`;
}

// =========================
// 💳 LISTAR CARTÕES
// =========================
async function listarCartoes(chatId) {
  const usuario = usuarios[chatId];
  const { data } = await supabase
    .from("gastos")
    .select("cartao")
    .eq("usuario", usuario)
    .not("cartao", "is", null);
  const cartoes = [...new Set(data.map(d => d.cartao))];
  if (cartoes.length === 0) {
    return "📭 Nenhum cartão registrado até agora.";
  }
  return `💳 Seus cartões:\n${cartoes.join('\n')}`;
}

// =========================
// 🔁 RECEITAS RECORRENTES
// =========================
async function listarRecorrentes(chatId) {
  const usuario = usuarios[chatId];
  const { data } = await supabase
    .from("receitas")
    .select("id, descricao, valor, dia_recorrencia, ativo")
    .eq("usuario", usuario)
    .eq("recorrente", true);
  if (!data || data.length === 0) {
    return "📭 Nenhuma receita recorrente ativa.";
  }
  let resposta = `🔄 RECEITAS RECORRENTES (${usuario})\n\n`;
  data.forEach(r => {
    resposta += `• ID: ${r.id}\n  ${r.descricao} - R$ ${r.valor} (dia ${r.dia_recorrencia}) ${r.ativo ? '✅' : '❌'}\n\n`;
  });
  resposta += "Para cancelar: /cancelarrecorrente <id>";
  return resposta;
}

async function cancelarRecorrente(chatId, id) {
  const usuario = usuarios[chatId];
  const { data } = await supabase
    .from("receitas")
    .select("id")
    .eq("id", id)
    .eq("usuario", usuario)
    .eq("recorrente", true)
    .single();
  if (!data) {
    return "❌ Recorrência não encontrada ou já cancelada.";
  }
  await supabase.from("receitas").update({ ativo: false }).eq("id", id);
  return "✅ Recorrência cancelada.";
}

// =========================
// 🔁 GASTOS RECORRENTES
// =========================
async function listarGastosRecorrentes(chatId) {
  const usuario = usuarios[chatId];
  const { data } = await supabase
    .from("gastos")
    .select("id, descricao, valor, dia_recorrencia, ativo")
    .eq("usuario", usuario)
    .eq("recorrente", true);
  if (!data || data.length === 0) {
    return "📭 Nenhum gasto recorrente ativo.";
  }
  let resposta = `🔄 GASTOS RECORRENTES (${usuario})\n\n`;
  data.forEach(g => {
    resposta += `• ID: ${g.id}\n  ${g.descricao} - R$ ${g.valor} (dia ${g.dia_recorrencia}) ${g.ativo ? '✅' : '❌'}\n\n`;
  });
  resposta += "Para cancelar: /cancelargastorecorrente <id>";
  return resposta;
}

async function cancelarGastoRecorrente(chatId, id) {
  const usuario = usuarios[chatId];
  const { data } = await supabase
    .from("gastos")
    .select("id")
    .eq("id", id)
    .eq("usuario", usuario)
    .eq("recorrente", true)
    .single();
  if (!data) {
    return "❌ Gasto recorrente não encontrado ou já cancelado.";
  }
  await supabase.from("gastos").update({ ativo: false }).eq("id", id);
  return "✅ Gasto recorrente cancelado.";
}

// =========================
// 🛠️ FUNÇÃO AUXILIAR (parcelas distribuídas no tempo)
// =========================
async function criarGastoParcelado(chatId, descricao, valorTotal, parcelas, cartao = null, forma_pagamento = "pix", categoria = "outros") {
  const usuario = usuarios[chatId];
  const principalId = uuidv4();

  const totalCentavos = Math.round(valorTotal * 100);
  const parcelaBaseCentavos = Math.floor(totalCentavos / parcelas);
  const sobraCentavos = totalCentavos - parcelaBaseCentavos * parcelas;

  for (let i = 1; i <= parcelas; i++) {
    let valorParcelaCentavos = parcelaBaseCentavos;
    if (i === 1) valorParcelaCentavos += sobraCentavos;
    const valorParcela = valorParcelaCentavos / 100;

    const dataParcela = moment().tz("America/Sao_Paulo").add(i - 1, 'months').toISOString();

    await supabase.from("gastos").insert({
      usuario,
      descricao: `${descricao} (${i}/${parcelas})`,
      categoria,
      valor: valorParcela,
      forma_pagamento: cartao ? "cartao_credito" : forma_pagamento,
      cartao,
      parcelado: true,
      parcelas: parcelas,
      parcela_numero: i,
      total_parcelas: parcelas,
      parcela_principal_id: principalId,
      created_at: dataParcela
    });
  }
}

// =========================
// 📸 HANDLER DE FOTOS (FATURA DE CARTÃO)
// =========================
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  if (!usuarios[chatId]) return;

  const legenda = (msg.caption || "").toLowerCase();
  if (!legenda.includes("fatura") && !legenda.includes("cartão") && !legenda.includes("cartao")) {
    return; // só processa se a legenda indicar fatura
  }

  try {
    await bot.sendMessage(chatId, "🔍 Analisando fatura...");
    const foto = msg.photo[msg.photo.length - 1]; // melhor resolução
    const fileUrl = await bot.getFileLink(foto.file_id);
    const dados = await analisarFatura(fileUrl);

    if (!dados.compras || dados.compras.length === 0) {
      return bot.sendMessage(chatId, "❌ Nenhuma compra identificada.");
    }

    let resposta = "📄 **FATURA ANALISADA**\n\n";
    dados.compras.forEach((c, i) => {
      resposta += `${i + 1}. ${c.descricao}\n`;
      resposta += `   💰 R$ ${Number(c.valor).toFixed(2)} | Parcela ${c.parcela_info} | ${c.categoria}\n`;
    });
    resposta += "\n✅ Registrar essas compras? (sim / não)";

    const idPend = `fatura_${chatId}`;
    if (pendencias.has(idPend)) clearTimeout(pendencias.get(idPend).timeout);
    const timeout = setTimeout(() => {
      pendencias.delete(idPend);
      bot.sendMessage(chatId, "⏰ Tempo esgotado.");
    }, 5 * 60 * 1000);
    pendencias.set(idPend, { tipo: "fatura", dados: dados.compras, timeout });

    await bot.sendMessage(chatId, resposta);

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "❌ Erro ao processar fatura. Tente outra imagem.");
  }
});

// =========================
// 🤖 HANDLER DE MENSAGENS DE TEXTO
// =========================
bot.on("message", async (msg) => {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!usuarios[chatId]) {
    return bot.sendMessage(chatId, "❌ Usuário não autorizado.");
  }

  // ⬇️ NOVA VERIFICAÇÃO: confirmação de fatura
  const pendFat = pendencias.get(`fatura_${chatId}`);
  if (pendFat && pendFat.tipo === "fatura") {
    clearTimeout(pendFat.timeout);
    pendencias.delete(`fatura_${chatId}`);

    if (text.trim().toLowerCase() === "sim") {
      for (const compra of pendFat.dados) {
        let parcelado = false;
        let parcelas = 1;
        let parcNum = 1;
        let totalParc = 1;

        if (compra.parcela_info && compra.parcela_info.includes("/")) {
          const partes = compra.parcela_info.split("/");
          parcNum = parseInt(partes[0]) || 1;
          totalParc = parseInt(partes[1]) || 1;
          if (totalParc > 1) {
            parcelado = true;
            parcelas = totalParc;
          }
        }

        await supabase.from("gastos").insert({
          usuario: usuarios[chatId],
          descricao: compra.descricao,
          categoria: compra.categoria || "outros",
          valor: Number(compra.valor),
          forma_pagamento: "cartao_credito",
          cartao: "Fatura",
          parcelado,
          parcelas,
          parcela_numero: parcNum,
          total_parcelas: totalParc,
          created_at: new Date().toISOString()
        });
      }
      return bot.sendMessage(chatId, `✅ ${pendFat.dados.length} compras registradas!`);
    } else {
      return bot.sendMessage(chatId, "❌ Registro cancelado.");
    }
  }

  // 🛑 Pendência de cartão (existente)
  if (pendencias.has(chatId)) {
    const pendente = pendencias.get(chatId);
    clearTimeout(pendente.timeout);
    pendencias.delete(chatId);
    const resposta = text.trim().toLowerCase();
    if (resposta === 'pix' || resposta === 'dinheiro' || resposta === 'pular' || resposta === 'sem cartao') {
      await criarGastoParcelado(
        chatId,
        pendente.dados.descricao,
        pendente.dados.valor,
        pendente.dados.parcelas,
        null,
        'pix',
        pendente.dados.categoria
      );
      return bot.sendMessage(chatId, `✅ Gasto parcelado registrado (sem cartão): ${pendente.dados.descricao} - ${pendente.dados.parcelas}x de R$ ${(pendente.dados.valor / pendente.dados.parcelas).toFixed(2)}`);
    }
    const cartao = text.trim();
    await criarGastoParcelado(
      chatId,
      pendente.dados.descricao,
      pendente.dados.valor,
      pendente.dados.parcelas,
      cartao,
      'cartao_credito',
      pendente.dados.categoria
    );
    return bot.sendMessage(chatId, `✅ Gasto parcelado registrado no cartão ${cartao}: ${pendente.dados.descricao} - ${pendente.dados.parcelas}x de R$ ${(pendente.dados.valor / pendente.dados.parcelas).toFixed(2)}`);
  }

  const isCommand = msg.entities && msg.entities.some(e => e.type === 'bot_command');
  if (isCommand) {
    const command = text.split(' ')[0].substring(1).toLowerCase();
    const args = text.substring(command.length + 1).trim();
    try {
      if (command === 'start') {
        return bot.sendMessage(chatId,
`👋 Olá, ${usuarios[chatId]}! Eu sou seu assistente financeiro.

Comandos disponíveis:
/saldo - Seu saldo individual (mês atual)
/geral - Saldo geral (Junior + Emanuelly)
/cartao Nome - Gastos de um cartão
/cartoes - Listar seus cartões
/gasto valor descrição [parcelas X] [dia X] - Registrar gasto
/receita valor descrição [dia X] - Registrar receita
/recorrentes - Ver receitas recorrentes ativas
/cancelarrecorrente <id> - Cancelar recorrência de receita
/gastosrecorrentes - Ver gastos recorrentes ativos
/cancelargastorecorrente <id> - Cancelar gasto recorrente

Ou fale naturalmente:
"Gastei 30 reais de almoço no cartão Nubank"
"Recebo 2000 de salário todo dia 5"
"Pago 1200 de aluguel todo dia 5"
"Comprei um tênis de 300 em 3x"
"Saldo geral"

📸 Para ler fatura: envie uma foto com a legenda "fatura"`
        );
      }
      if (command === 'saldo') {
        const s = await saldoIndividual(chatId);
        return bot.sendMessage(chatId,
`💰 SALDO (${usuarios[chatId]}) - MÊS ATUAL

📥 Receitas: ${s.receitas.toFixed(2)}
📤 Gastos: ${s.gastos.toFixed(2)}
💳 Saldo: ${s.saldo.toFixed(2)}`
        );
      }
      if (command === 'geral') {
        const resposta = await saldoGeral();
        return bot.sendMessage(chatId, resposta);
      }
      if (command === 'cartao') {
        if (!args) return bot.sendMessage(chatId, "❌ Use: /cartao NomeDoCartao");
        const resposta = await gastosPorCartao(chatId, args);
        return bot.sendMessage(chatId, resposta);
      }
      if (command === 'cartoes') {
        const resposta = await listarCartoes(chatId);
        return bot.sendMessage(chatId, resposta);
      }
      if (command === 'gasto') {
        if (!args) return bot.sendMessage(chatId, "❌ Use: /gasto valor descrição [parcelas X] [dia X]");
        const parts = args.split(' ');
        const valor = parseFloat(parts[0]);
        if (isNaN(valor) || valor <= 0) return bot.sendMessage(chatId, "❌ Valor inválido.");

        let descricao = "";
        let parcelas = 1;
        let diaRecorrencia = null;

        const parcelasRegex = /(?:parcelas?\s*)?(\d+)\s*x/i;
        const matchParcela = args.match(parcelasRegex);
        if (matchParcela) {
          parcelas = parseInt(matchParcela[1]);
          if (isNaN(parcelas) || parcelas < 1) parcelas = 1;
          const textoSemParcela = args.replace(matchParcela[0], '').trim();
          descricao = textoSemParcela.split(' ').slice(1).join(' ');
        }

        const diaRegex = /(?:todo\s+)?dia\s+(\d{1,2})\b/i;
        const matchDia = args.match(diaRegex);
        if (matchDia) {
          diaRecorrencia = parseInt(matchDia[1]);
          if (isNaN(diaRecorrencia)) diaRecorrencia = null;
          const textoSemDia = args.replace(matchDia[0], '').trim();
          if (!descricao) descricao = textoSemDia.split(' ').slice(1).join(' ');
        }

        if (!descricao) descricao = parts.slice(1).join(' ').replace(/parcelas?\s*\d+\s*x?/i, '').replace(/(?:todo\s+)?dia\s+\d{1,2}/i, '').trim() || 'sem descrição';

        if (diaRecorrencia) {
          await supabase.from("gastos").insert({
            usuario: usuarios[chatId],
            descricao,
            categoria: "outros",
            valor,
            forma_pagamento: "pix",
            cartao: null,
            parcelado: false,
            parcelas: 1,
            recorrente: true,
            dia_recorrencia: diaRecorrencia,
            ativo: true,
            created_at: new Date().toISOString()
          });
          return bot.sendMessage(chatId, `✅ Gasto recorrente registrado: ${descricao} - R$ ${valor.toFixed(2)} todo dia ${diaRecorrencia}`);
        }

        if (parcelas > 1) {
          const timeout = setTimeout(() => {
            pendencias.delete(chatId);
            bot.sendMessage(chatId, "⏰ Tempo esgotado. Registro cancelado.");
          }, 5 * 60 * 1000);
          pendencias.set(chatId, { dados: { descricao, valor, parcelas, categoria: "outros" }, timeout });
          return bot.sendMessage(chatId, `📋 Compra parcelada: ${descricao} - ${parcelas}x de R$ ${(valor / parcelas).toFixed(2)}\n💳 Qual cartão foi usado?\n(Responda com o nome do cartão ou "pix" / "pular" para sem cartão)`);
        }

        await criarGastoParcelado(chatId, descricao, valor, 1);
        return bot.sendMessage(chatId, `✅ Gasto registrado: ${descricao} - R$ ${valor.toFixed(2)}`);
      }
      if (command === 'receita') {
        if (!args) return bot.sendMessage(chatId, "❌ Use: /receita valor descrição [dia X]");
        const parts = args.split(' ');
        const valor = parseFloat(parts[0]);
        if (isNaN(valor) || valor <= 0) return bot.sendMessage(chatId, "❌ Valor inválido.");
        let descricao = "";
        let diaRecorrencia = null;
        const diaIndex = parts.findIndex(p => p.toLowerCase() === 'dia');
        if (diaIndex !== -1 && parts[diaIndex + 1]) {
          diaRecorrencia = parseInt(parts[diaIndex + 1]);
          descricao = parts.slice(1, diaIndex).join(' ') || 'sem descrição';
        } else {
          descricao = parts.slice(1).join(' ') || 'sem descrição';
        }
        await supabase.from("receitas").insert({
          usuario: usuarios[chatId],
          descricao,
          valor,
          recorrente: diaRecorrencia ? true : false,
          dia_recorrencia: diaRecorrencia,
          ativo: true,
          created_at: new Date().toISOString()
        });
        return bot.sendMessage(chatId,
          `💰 Receita registrada: ${descricao} - R$ ${valor.toFixed(2)}` +
          (diaRecorrencia ? ` (recorrente todo dia ${diaRecorrencia})` : '')
        );
      }
      if (command === 'recorrentes') {
        const resposta = await listarRecorrentes(chatId);
        return bot.sendMessage(chatId, resposta);
      }
      if (command === 'cancelarrecorrente') {
        if (!args) return bot.sendMessage(chatId, "❌ Use: /cancelarrecorrente <id>");
        const resposta = await cancelarRecorrente(chatId, args);
        return bot.sendMessage(chatId, resposta);
      }
      if (command === 'gastosrecorrentes') {
        const resposta = await listarGastosRecorrentes(chatId);
        return bot.sendMessage(chatId, resposta);
      }
      if (command === 'cancelargastorecorrente') {
        if (!args) return bot.sendMessage(chatId, "❌ Use: /cancelargastorecorrente <id>");
        const resposta = await cancelarGastoRecorrente(chatId, args);
        return bot.sendMessage(chatId, resposta);
      }
      return bot.sendMessage(chatId, "❓ Comando não reconhecido.");
    } catch (err) {
      console.error(err);
      return bot.sendMessage(chatId, "❌ Erro ao processar comando.");
    }
  }

  // =========================
  // MENSAGENS NORMAIS (IA)
  // =========================
  try {
    const textLower = text.toLowerCase();
    if (textLower.includes("saldo geral") || textLower === "geral") {
      const resposta = await saldoGeral();
      return bot.sendMessage(chatId, resposta);
    }
    if (textLower.includes("saldo")) {
      const s = await saldoIndividual(chatId);
      return bot.sendMessage(chatId,
`💰 SALDO (${usuarios[chatId]}) - MÊS ATUAL

📥 Receitas: ${s.receitas.toFixed(2)}
📤 Gastos: ${s.gastos.toFixed(2)}
💳 Saldo: ${s.saldo.toFixed(2)}`
      );
    }
    if (textLower.startsWith("cartao ")) {
      const cartao = text.replace(/^cartao\s+/i, "").trim();
      const resposta = await gastosPorCartao(chatId, cartao);
      return bot.sendMessage(chatId, resposta);
    }

    const data = await interpretar(text);
    if (data.type === "gasto") {
      const parsed = gastoSchema.parse(data);
      if (parsed.recorrente) {
        await supabase.from("gastos").insert({
          usuario: usuarios[chatId],
          descricao: parsed.descricao,
          categoria: parsed.categoria || "outros",
          valor: parsed.valor,
          forma_pagamento: parsed.forma_pagamento || "pix",
          cartao: parsed.cartao || null,
          parcelado: false,
          parcelas: 1,
          recorrente: true,
          dia_recorrencia: parsed.dia_recorrencia || moment().tz("America/Sao_Paulo").date(),
          ativo: true,
          created_at: new Date().toISOString()
        });
        return bot.sendMessage(chatId,
          `✅ Gasto recorrente registrado: ${parsed.descricao} - R$ ${parsed.valor.toFixed(2)}` +
          (parsed.dia_recorrencia ? ` todo dia ${parsed.dia_recorrencia}` : '')
        );
      }
      if (parsed.parcelado && parsed.parcelas > 1) {
        if (parsed.cartao) {
          await criarGastoParcelado(chatId, parsed.descricao, parsed.valor, parsed.parcelas, parsed.cartao, parsed.forma_pagamento, parsed.categoria);
          return bot.sendMessage(chatId,
            `✅ Gasto parcelado registrado: ${parsed.descricao} - ${parsed.parcelas}x de R$ ${(parsed.valor / parsed.parcelas).toFixed(2)} no cartão ${parsed.cartao}`
          );
        } else {
          const timeout = setTimeout(() => {
            pendencias.delete(chatId);
            bot.sendMessage(chatId, "⏰ Tempo esgotado. Registro cancelado.");
          }, 5 * 60 * 1000);
          pendencias.set(chatId, {
            dados: { descricao: parsed.descricao, valor: parsed.valor, parcelas: parsed.parcelas, categoria: parsed.categoria || "outros" },
            timeout
          });
          return bot.sendMessage(chatId,
            `📋 Compra parcelada: ${parsed.descricao} - ${parsed.parcelas}x de R$ ${(parsed.valor / parsed.parcelas).toFixed(2)}\n💳 Qual cartão foi usado?\n(Responda com o nome do cartão ou "pix" / "pular" para sem cartão)`
          );
        }
      }
      // Gasto simples
      await supabase.from("gastos").insert({
        usuario: usuarios[chatId],
        descricao: parsed.descricao,
        categoria: parsed.categoria || "outros",
        valor: parsed.valor,
        forma_pagamento: parsed.forma_pagamento || "pix",
        cartao: parsed.cartao || null,
        parcelado: false,
        parcelas: 1,
        created_at: new Date().toISOString()
      });
      return bot.sendMessage(chatId, "✅ Gasto registrado");
    }
    if (data.type === "receita") {
      const parsed = receitaSchema.parse(data);
      await supabase.from("receitas").insert({
        usuario: usuarios[chatId],
        descricao: parsed.descricao,
        valor: parsed.valor,
        recorrente: parsed.recorrente || false,
        dia_recorrencia: parsed.dia_recorrencia || null,
        ativo: true,
        created_at: new Date().toISOString()
      });
      let msg = "💰 Receita registrada";
      if (parsed.recorrente && parsed.dia_recorrencia) {
        msg += ` (recorrente todo dia ${parsed.dia_recorrencia})`;
      }
      return bot.sendMessage(chatId, msg);
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "❌ Erro ao processar. Tente reformular.");
  }
});

// =========================
// ⏰ AGENDAMENTOS
// =========================
const TIMEZONE = "America/Sao_Paulo";
cron.schedule("0 20 * * *", async () => {
  for (const chatId of Object.keys(usuarios)) {
    try { await bot.sendMessage(chatId, "🌙 Já registrou seus gastos de hoje?"); } catch (err) {}
  }
}, { timezone: TIMEZONE });
cron.schedule("0 9 * * 6", async () => {
  const hoje = moment().tz(TIMEZONE);
  const seteDiasAtras = hoje.clone().subtract(7, 'days');
  for (const [chatId, nome] of Object.entries(usuarios)) {
    try {
      const { data: gastos } = await supabase.from("gastos").select("valor").eq("usuario", nome).gte("created_at", seteDiasAtras.toISOString()).lt("created_at", hoje.toISOString());
      const { data: receitas } = await supabase.from("receitas").select("valor").eq("usuario", nome).gte("created_at", seteDiasAtras.toISOString()).lt("created_at", hoje.toISOString());
      const totalGastos = (gastos || []).reduce((s, g) => s + Number(g.valor || 0), 0);
      const totalReceitas = (receitas || []).reduce((s, r) => s + Number(r.valor || 0), 0);
      await bot.sendMessage(chatId, `📆 RESUMO DA SEMANA\nDe ${seteDiasAtras.format("DD/MM")} a ${hoje.format("DD/MM")}\n\n💵 Receitas: R$ ${totalReceitas.toFixed(2)}\n💳 Gastos: R$ ${totalGastos.toFixed(2)}\n💰 Saldo: R$ ${(totalReceitas - totalGastos).toFixed(2)}`);
    } catch (err) {}
  }
}, { timezone: TIMEZONE });
cron.schedule("0 10 23 * *", async () => {
  const hoje = moment().tz(TIMEZONE);
  const mesAtual = hoje.month();
  const ano = hoje.year();
  const inicio = moment().tz(TIMEZONE).year(ano).month(mesAtual - 1).date(23).startOf('day');
  const fim = moment().tz(TIMEZONE).year(ano).month(mesAtual).date(23).endOf('day');
  for (const [chatId, nome] of Object.entries(usuarios)) {
    try {
      const { data: gastos } = await supabase.from("gastos").select("valor").eq("usuario", nome).gte("created_at", inicio.toISOString()).lt("created_at", fim.toISOString());
      const { data: receitas } = await supabase.from("receitas").select("valor").eq("usuario", nome).gte("created_at", inicio.toISOString()).lt("created_at", fim.toISOString());
      const totalGastos = (gastos || []).reduce((s, g) => s + Number(g.valor || 0), 0);
      const totalReceitas = (receitas || []).reduce((s, r) => s + Number(r.valor || 0), 0);
      await bot.sendMessage(chatId, `📊 FECHAMENTO (23/${mesAtual + 1})\nPeríodo: ${inicio.format("DD/MM")} a ${fim.format("DD/MM")}\n\n💰 Receitas: R$ ${totalReceitas.toFixed(2)}\n💸 Gastos: R$ ${totalGastos.toFixed(2)}\n📈 Saldo: R$ ${(totalReceitas - totalGastos).toFixed(2)}`);
    } catch (err) {}
  }
}, { timezone: TIMEZONE });
cron.schedule("0 1 * * *", async () => {
  const hoje = moment().tz(TIMEZONE);
  const diaHoje = hoje.date();
  for (const [chatId, nome] of Object.entries(usuarios)) {
    const { data: recorrentesReceitas } = await supabase.from("receitas").select("*").eq("usuario", nome).eq("recorrente", true).eq("ativo", true).eq("dia_recorrencia", diaHoje);
    if (recorrentesReceitas) {
      for (const rec of recorrentesReceitas) {
        try {
          const inicioDia = hoje.clone().startOf('day').toISOString();
          const fimDia = hoje.clone().endOf('day').toISOString();
          const { data: jaLancada } = await supabase.from("receitas").select("id").eq("usuario", nome).eq("descricao", rec.descricao).eq("valor", rec.valor).gte("created_at", inicioDia).lt("created_at", fimDia);
          if (!jaLancada || jaLancada.length === 0) {
            await supabase.from("receitas").insert({ usuario: nome, descricao: rec.descricao + " (recorrente)", valor: rec.valor, recorrente: false, created_at: new Date().toISOString() });
          }
        } catch (err) {}
      }
    }
    const { data: recorrentesGastos } = await supabase.from("gastos").select("*").eq("usuario", nome).eq("recorrente", true).eq("ativo", true).eq("dia_recorrencia", diaHoje);
    if (recorrentesGastos) {
      for (const rec of recorrentesGastos) {
        try {
          const inicioDia = hoje.clone().startOf('day').toISOString();
          const fimDia = hoje.clone().endOf('day').toISOString();
          const { data: jaLancada } = await supabase.from("gastos").select("id").eq("usuario", nome).eq("descricao", rec.descricao).eq("valor", rec.valor).eq("recorrente", false).gte("created_at", inicioDia).lt("created_at", fimDia);
          if (!jaLancada || jaLancada.length === 0) {
            await supabase.from("gastos").insert({ usuario: nome, descricao: rec.descricao + " (recorrente)", categoria: rec.categoria || "outros", valor: rec.valor, forma_pagamento: rec.forma_pagamento || "pix", cartao: rec.cartao || null, parcelado: false, parcelas: 1, recorrente: false, created_at: new Date().toISOString() });
          }
        } catch (err) {}
      }
    }
  }
}, { timezone: TIMEZONE });

// =========================
// 🌐 SERVER
// =========================
app.get("/", (req, res) => res.send("Bot rodando via webhook"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot rodando com webhook e gastos recorrentes.");
});
