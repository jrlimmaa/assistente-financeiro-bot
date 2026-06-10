import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";
import cron from "node-cron";
import { z } from "zod";
import moment from "moment-timezone";

dotenv.config();

const app = express();
app.use(express.json());

// =========================
// 🔌 CONEXÕES
// =========================

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

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
// 📋 COMANDOS DO MENU
// =========================
(async () => {
  await bot.setMyCommands([
    { command: "start", description: "Ver todos os comandos" },
    { command: "saldo", description: "Seu saldo individual" },
    { command: "geral", description: "Saldo geral (Junior + Emanuelly)" },
    { command: "cartao", description: "Ver gastos de um cartão (ex: /cartao Visa)" },
    { command: "cartoes", description: "Listar seus cartões cadastrados" },
    { command: "gasto", description: "Registrar gasto rápido (ex: /gasto 50 almoço)" },
    { command: "receita", description: "Registrar receita rápida (ex: /receita 200 salário)" }
  ]);
})();

// =========================
// 🧠 IA PROMPT
// =========================

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
  "parcelas": number
}

Se for receita:
{
  "type": "receita",
  "descricao": "",
  "valor": number,
  "recorrente": boolean
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
  parcelas: z.number().int().min(1).default(1)
});

const receitaSchema = z.object({
  type: z.literal("receita"),
  descricao: z.string().min(1),
  valor: z.number().positive(),
  recorrente: z.boolean().default(false)
});

// =========================
// 💰 SALDO INDIVIDUAL
// =========================

async function saldoIndividual(chatId) {
  const usuario = usuarios[chatId];

  const { data: gastos } = await supabase
    .from("gastos")
    .select("valor")
    .eq("usuario", usuario);

  const { data: receitas } = await supabase
    .from("receitas")
    .select("valor")
    .eq("usuario", usuario);

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
    .select("descricao, valor, parcelas")
    .eq("usuario", usuario)
    .eq("cartao", cartaoNome);

  if (!data || data.length === 0) {
    return `💳 Nenhum gasto encontrado no cartão ${cartaoNome}`;
  }

  let total = 0;
  const lista = data.map(g => {
    total += Number(g.valor);
    return `• ${g.descricao} - R$ ${g.valor} (${g.parcelas}x)`;
  }).join("\n");

  return `💳 CARTÃO: ${cartaoNome}

${lista}

💰 TOTAL: R$ ${total.toFixed(2)}`;
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
// 🤖 BOT – HANDLER
// =========================

bot.on("message", async (msg) => {
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  // Verificar se usuário está mapeado
  if (!usuarios[chatId]) {
    return bot.sendMessage(chatId, "❌ Usuário não autorizado. Entre em contato com o administrador.");
  }

  // Se for comando (entidade bot_command)
  const isCommand = msg.entities && msg.entities.some(e => e.type === 'bot_command');

  if (isCommand) {
    const command = text.split(' ')[0].substring(1).toLowerCase();
    const args = text.substring(command.length + 1).trim();

    try {
      if (command === 'start') {
        return bot.sendMessage(chatId,
`👋 Olá, ${usuarios[chatId]}! Eu sou seu assistente financeiro.

Comandos disponíveis:
/saldo - Ver seu saldo individual
/geral - Saldo geral (Junior + Emanuelly)
/cartao Nome - Gastos de um cartão
/cartoes - Listar seus cartões
/gasto valor descrição - Registrar gasto
/receita valor descrição - Registrar receita

Ou fale naturalmente, como:
"Gastei 30 reais de almoço no cartão Nubank"
"Recebi 500 de pagamento"
"Saldo geral"`
        );
      }

      if (command === 'saldo') {
        const s = await saldoIndividual(chatId);
        return bot.sendMessage(chatId,
`💰 SALDO (${usuarios[chatId]})

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
        if (!args) return bot.sendMessage(chatId, "❌ Use: /gasto valor descrição");
        const parts = args.split(' ');
        const valor = parseFloat(parts[0]);
        if (isNaN(valor) || valor <= 0) return bot.sendMessage(chatId, "❌ Valor inválido.");
        const descricao = parts.slice(1).join(' ') || 'sem descrição';
        await supabase.from("gastos").insert({
          usuario: usuarios[chatId],
          descricao,
          categoria: "outros",
          valor,
          forma_pagamento: "pix",
          parcelado: false,
          parcelas: 1,
          cartao: null,
          created_at: new Date().toISOString()
        });
        return bot.sendMessage(chatId, `✅ Gasto registrado: ${descricao} - R$ ${valor.toFixed(2)}`);
      }

      if (command === 'receita') {
        if (!args) return bot.sendMessage(chatId, "❌ Use: /receita valor descrição");
        const parts = args.split(' ');
        const valor = parseFloat(parts[0]);
        if (isNaN(valor) || valor <= 0) return bot.sendMessage(chatId, "❌ Valor inválido.");
        const descricao = parts.slice(1).join(' ') || 'sem descrição';
        await supabase.from("receitas").insert({
          usuario: usuarios[chatId],
          descricao,
          valor,
          recorrente: false,
          created_at: new Date().toISOString()
        });
        return bot.sendMessage(chatId, `💰 Receita registrada: ${descricao} - R$ ${valor.toFixed(2)}`);
      }

      return bot.sendMessage(chatId, "❓ Comando não reconhecido.");
    } catch (err) {
      console.error(err);
      return bot.sendMessage(chatId, "❌ Erro ao processar comando.");
    }
  }

  // =========================
  // MENSAGENS NORMAIS
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
`💰 SALDO (${usuarios[chatId]})

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

    // 🧠 IA
    const data = await interpretar(text);

    if (data.type === "gasto") {
      const parsed = gastoSchema.parse(data);
      await supabase.from("gastos").insert({
        usuario: usuarios[chatId],
        descricao: parsed.descricao,
        categoria: parsed.categoria || "outros",
        valor: parsed.valor,
        forma_pagamento: parsed.forma_pagamento || "pix",
        cartao: parsed.cartao || null,
        parcelado: parsed.parcelado || false,
        parcelas: parsed.parcelas || 1,
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
        created_at: new Date().toISOString()
      });
      return bot.sendMessage(chatId, "💰 Receita registrada");
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "❌ Erro ao processar. Tente reformular.");
  }
});

// =========================
// ⏰ AGENDAMENTOS (node-cron)
// =========================

const TIMEZONE = "America/Sao_Paulo";

// 🌙 Lembrete diário às 20h
cron.schedule("0 20 * * *", async () => {
  for (const chatId of Object.keys(usuarios)) {
    try {
      await bot.sendMessage(chatId, "🌙 Já registrou seus gastos de hoje?");
    } catch (err) {
      console.error(`Erro ao enviar lembrete para ${chatId}:`, err.message);
    }
  }
}, { timezone: TIMEZONE });

// 📆 Relatório semanal (sábado às 9h)
cron.schedule("0 9 * * 6", async () => {
  const hoje = moment().tz(TIMEZONE);
  const seteDiasAtras = hoje.clone().subtract(7, 'days');

  for (const [chatId, nome] of Object.entries(usuarios)) {
    try {
      const { data: gastos } = await supabase
        .from("gastos")
        .select("valor")
        .eq("usuario", nome)
        .gte("created_at", seteDiasAtras.toISOString())
        .lt("created_at", hoje.toISOString());

      const { data: receitas } = await supabase
        .from("receitas")
        .select("valor")
        .eq("usuario", nome)
        .gte("created_at", seteDiasAtras.toISOString())
        .lt("created_at", hoje.toISOString());

      const totalGastos = (gastos || []).reduce((s, g) => s + Number(g.valor || 0), 0);
      const totalReceitas = (receitas || []).reduce((s, r) => s + Number(r.valor || 0), 0);
      const saldo = totalReceitas - totalGastos;

      await bot.sendMessage(chatId,
`📆 RESUMO DA SEMANA
De ${seteDiasAtras.format("DD/MM")} a ${hoje.format("DD/MM")}

💵 Receitas: R$ ${totalReceitas.toFixed(2)}
💳 Gastos: R$ ${totalGastos.toFixed(2)}
💰 Saldo: R$ ${saldo.toFixed(2)}`
      );
    } catch (err) {
      console.error(`Erro no relatório semanal para ${chatId}:`, err.message);
    }
  }
}, { timezone: TIMEZONE });

// 📅 Fechamento mensal (todo dia 23 às 10h)
cron.schedule("0 10 23 * *", async () => {
  const hoje = moment().tz(TIMEZONE);
  const mesAtual = hoje.month(); // 0-11
  const ano = hoje.year();

  // Definir início no dia 23 do mês anterior
  const inicio = moment().tz(TIMEZONE).year(ano).month(mesAtual - 1).date(23).startOf('day');
  const fim = moment().tz(TIMEZONE).year(ano).month(mesAtual).date(23).endOf('day');

  for (const [chatId, nome] of Object.entries(usuarios)) {
    try {
      const { data: gastos } = await supabase
        .from("gastos")
        .select("valor")
        .eq("usuario", nome)
        .gte("created_at", inicio.toISOString())
        .lt("created_at", fim.toISOString());

      const { data: receitas } = await supabase
        .from("receitas")
        .select("valor")
        .eq("usuario", nome)
        .gte("created_at", inicio.toISOString())
        .lt("created_at", fim.toISOString());

      const totalGastos = (gastos || []).reduce((s, g) => s + Number(g.valor || 0), 0);
      const totalReceitas = (receitas || []).reduce((s, r) => s + Number(r.valor || 0), 0);
      const saldo = totalReceitas - totalGastos;

      await bot.sendMessage(chatId,
`📊 FECHAMENTO (23/${mesAtual + 1})
Período: ${inicio.format("DD/MM")} a ${fim.format("DD/MM")}

💰 Receitas: R$ ${totalReceitas.toFixed(2)}
💸 Gastos: R$ ${totalGastos.toFixed(2)}
📈 Saldo: R$ ${saldo.toFixed(2)}`
      );
    } catch (err) {
      console.error(`Erro no fechamento para ${chatId}:`, err.message);
    }
  }
}, { timezone: TIMEZONE });

// =========================
// 🌐 SERVER
// =========================

app.get("/", (req, res) => res.send("Bot rodando"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot rodando com agendamentos e cartões dinâmicos.");
});