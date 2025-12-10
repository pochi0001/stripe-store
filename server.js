import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bodyParser from "body-parser";

dotenv.config();
console.log("Stripe Secret Key:", process.env.STRIPE_SECRET_KEY);

// -------------------------------
// ✅ SQLite データベース設定
// -------------------------------
const dbPromise = open({
  filename: "./database.db",
  driver: sqlite3.Database,
});

(async () => {
  const db = await dbPromise;
  await db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount INTEGER,
    description TEXT,
    created_at TEXT,
    method TEXT,
    name TEXT,
    address TEXT,
    phone TEXT
  );
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    price INTEGER,
    stock INTEGER
  );
`);

  const existing = await db.get("SELECT COUNT(*) AS count FROM products");
  if (existing.count === 0) {
    await db.run(`
      INSERT INTO products (name, price, stock) VALUES
      ('Trainer free size', 8500, 9)
    `);
  }
})();

// -------------------------------
// ✅ Express & Stripe設定
// -------------------------------
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.static("public"));

// ⚠️ Webhook専用なので /webhook 以外は express.json() を使用
app.use((req, res, next) => {
  if (req.originalUrl === "/webhook") return next();
  express.json()(req, res, next);
});

// -------------------------------
// ✅ Nodemailer設定
// -------------------------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// 商品一覧を返す API
app.get("/products", async (req, res) => {
  const db = await dbPromise;
  const products = await db.all("SELECT * FROM products");
  res.json(products);
});

// -------------------------------
// ✅ 支払いIntentを作成（Stripeカード用）
// -------------------------------
app.post("/create-payment-intent", async (req, res) => {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: req.body.amount,
      currency: "jpy",
      description: req.body.description,
      metadata: {
        name: req.body.name,
        address: req.body.address,
        phone: req.body.phone
      },
      automatic_payment_methods: { enabled: true },
    });

    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("❌ 支払いIntent作成エラー:", err);
    res.status(500).send({ error: err.message });
  }
});

// -------------------------------
// ✅ Webhook（Stripe決済成功 → メール + DB登録 + 在庫減少）
// -------------------------------
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook署名エラー:", err.message);
      console.error("🔥 Webhook 内部エラー詳細:", err.stack || err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
      
    }

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      const db = await dbPromise;

      // 在庫を1つ減らす（商品が残っている場合のみ）
      const result = await db.run(
        "UPDATE products SET stock = stock - 1 WHERE name = ? AND stock > 0",
        [paymentIntent.description]
      );

      if (result.changes === 0) {
        console.log("⚠️ 在庫不足：", paymentIntent.description);
      }

      console.log("💰 Stripe支払い成功:", paymentIntent.id);



      // メール通知
      // await transporter.sendMail({
      //   from: process.env.GMAIL_USER,
      //   to: process.env.EMAIL_TO,
      //   subject: "🎉 支払いが完了しました！",
      //   text: `購入金額: ¥${paymentIntent.amount / 100}\n説明: ${paymentIntent.description}\n方法: カード`,
      // });




      // DB保存
      await db.run(
  "INSERT INTO payments (amount, description, created_at, method, name, address, phone) VALUES (?, ?, ?, ?, ?, ?, ?)",
  [
    paymentIntent.amount,
    paymentIntent.description,
    new Date().toISOString(),
    "カード",
    paymentIntent.metadata?.name || "",
    paymentIntent.metadata?.address || "",
    paymentIntent.metadata?.phone || "",
  ]
);
    }

    res.json({ received: true });
  }
);

// -------------------------------
// ✅ PayPay決済成功処理（メール + DB登録 + 在庫減少）
// -------------------------------
app.post("/paypay-payment", async (req, res) => {
  const { amount, description } = req.body;
  const db = await dbPromise;

  const result = await db.run(
    "UPDATE products SET stock = stock - 1 WHERE name = ? AND stock > 0",
    [description]
  );

  if (result.changes === 0) {
    console.log("⚠️ 在庫不足：", description);
    return res.json({ status: "fail", message: "在庫不足です" });
  }

  await db.run(
  "INSERT INTO payments (amount, description, created_at, method, name, address, phone) VALUES (?, ?, ?, ?, ?, ?, ?)",
  [amount, description, new Date().toISOString(), "PayPay", req.body.name, req.body.address, req.body.phone]
);

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: "🎉 PayPay支払いが完了しました！",
    text: `購入金額: ¥${amount}\n説明: ${description}\n方法: PayPay`,
  });

  res.json({ status: "success" });
});

// -------------------------------
// ✅ 管理ページ：支払い履歴表示
// -------------------------------
app.use('/admin', (req, res, next) => {
  const auth = { login: 'admin', password: 'pass123' };
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (login && password && login === auth.login && password === auth.password) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  res.status(401).send('認証が必要です');
});


app.get("/admin", async (req, res) => {
  const db = await dbPromise;
  const payments = await db.all(
    "SELECT * FROM payments ORDER BY created_at DESC"
  );

  let html = `
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <title>支払い履歴</title>
    <link rel="stylesheet" href="/admin.css">
  </head>
  <body>
    <h1>💰 支払い履歴</h1>
    <table>
      <tr>
        <th>ID</th>
        <th>金額 (円)</th>
        <th>説明</th>
        <th>名前</th>
        <th>住所</th>
        <th>電話番号</th>
        <th>日時</th>
        <th>方法</th>
      </tr>
  `;

  for (const p of payments) {
    html += `
      <tr>
        <td>${p.id}</td>
        <td>¥${p.amount / 100}</td>
        <td>${p.description}</td>
        <td>${p.name || ""}</td>
        <td>${p.address || ""}</td>
        <td>${p.phone || ""}</td>
        <td>${new Date(p.created_at).toLocaleString("ja-JP")}</td>
        <td>${p.method}</td>
      </tr>
    `;
  }

  html += `
      </table>
    </body>
    </html>
  `;

  res.send(html);
});

// -------------------------------
// ✅ サーバー起動
// -------------------------------
app.listen(3000, () =>
  console.log("🚀 サーバー起動中：http://localhost:3000")
);




// app.get("/test-mail", async (req, res) => {
//   try {
//     await transporter.sendMail({
//       from: process.env.GMAIL_USER,
//       to: process.env.GMAIL_USER, // 自分に送る
//       subject: "テストメール",
//       text: "メール送信成功です！",
//     });

//     res.send("メール送信成功！");
//   } catch (err) {
//     console.error("🔥 メール送信エラー:", err);
//     res.status(500).send("メール送信エラー");
//   }
// });