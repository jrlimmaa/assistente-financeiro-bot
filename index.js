import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";

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
    model: "gpt-5.4-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: texto }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}

// =========================
// 💰 SALDO
// =========================

async function saldoTotal(chatId) {
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
// 🤖 BOT
// =========================

bot.on("message", async (msg) => {
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.toLowerCase();

  try {

    // 💳 CARTÃO (novo comando)
    if (text.startsWith("cartao ")) {
      const cartao = text.replace("cartao ", "").trim();
      const resposta = await gastosPorCartao(chatId, cartao);
      return bot.sendMessage(chatId, resposta);
    }

    // 💰 SALDO
    if (text.includes("saldo")) {
      const s = await saldoTotal(chatId);

      return bot.sendMessage(chatId,
`💰 SALDO (${usuarios[chatId]})

📥 Receitas: ${s.receitas.toFixed(2)}
📤 Gastos: ${s.gastos.toFixed(2)}
💳 Saldo: ${s.saldo.toFixed(2)}`
      );
    }

    // 🧠 IA
    const data = await interpretar(text);
    const usuario = usuarios[chatId];

    if (data.type === "gasto") {
      await supabase.from("gastos").insert({
        usuario,
        descricao: data.descricao,
        categoria: data.categoria || "outros",
        valor: data.valor || 0,
        forma_pagamento: data.forma_pagamento || "pix",
        cartao: data.cartao || null,
        parcelado: data.parcelado || false,
        parcelas: data.parcelas || 1
      });

      return bot.sendMessage(chatId, "✅ Gasto registrado");
    }

    if (data.type === "receita") {
      await supabase.from("receitas").insert({
        usuario,
        descricao: data.descricao,
        valor: data.valor || 0,
        recorrente: data.recorrente || false
      });

      return bot.sendMessage(chatId, "💰 Receita registrada");
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "❌ Erro ao processar");
  }
});

// =========================
// 🌐 SERVER
// =========================

app.get("/", (req, res) => res.send("Bot rodando"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot rodando");
});
