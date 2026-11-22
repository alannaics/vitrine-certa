"use strict";
const express = require("express");
const crypto = require("node:crypto");
const router = express.Router();
const TYPES = new Set(["sale","expense"]);
const MAX_AMOUNT = 100000000;
function validate(input) {
  if (!input || !TYPES.has(input.type)) throw new Error("Tipo inválido.");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw new Error("Valor inválido.");
  const date = String(input.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + "T12:00:00Z"))) throw new Error("Data inválida.");
  const product = String(input.product || "").trim().slice(0, 120);
  const channel = String(input.channel || "").trim().slice(0, 80);
  const notes = String(input.notes || "").trim().slice(0, 500);
  if (!product) throw new Error("Informe o produto ou campanha.");
  return {type:input.type,amount:Math.round(amount*100),date,product,channel,notes};
}
function summary(rows) {
  let sales=0,expenses=0;
  const daily={};
  for(const r of rows) {
    const value=Number(r.amount_cents);
    const date=String(r.entry_date).slice(0,10);
    if(!daily[date]) daily[date]={date,sales:0,expenses:0,profit:0};
    if(r.type==="sale"){sales+=value;daily[date].sales+=value;}
    else {expenses+=value;daily[date].expenses+=value;}
  }
  return {sales:sales/100,expenses:expenses/100,profit:(sales-expenses)/100,roi:expenses>0?(sales-expenses)/expenses*100:null,daily:Object.values(daily).map(d=>({...d,sales:d.sales/100,expenses:d.expenses/100,profit:(d.sales-d.expenses)/100})).sort((a,b)=>a.date.localeCompare(b.date))};
}
function registerFinance(app,db,auth){
  app.use("/api/finance",auth,router);
  router.use((req,res,next)=>{if(!db)return res.status(503).json({error:"Banco não configurado."});next();});
  router.get("/entries",async(req,res)=>{
    try {
      const result=await db.query("SELECT id,type,amount_cents,entry_date::text,product,channel,notes,created_at FROM finance_entries ORDER BY entry_date DESC,created_at DESC LIMIT 3000");
      res.json({entries:result.rows,summary:summary(result.rows)});
    }catch(e){console.error("[finance GET]",e.message);res.status(500).json({error:"Falha ao consultar registros."});}
  });
  router.post("/entries",express.json(),async(req,res)=>{
    let entry;
    try{entry=validate(req.body);}catch(e){return res.status(400).json({error:e.message});}
    try{
      const id=crypto.randomUUID();
      await db.query("INSERT INTO finance_entries (id,type,amount_cents,entry_date,product,channel,notes) VALUES ($1,$2,$3,$4,$5,$6,$7)",[id,entry.type,entry.amount,entry.date,entry.product,entry.channel,entry.notes]);
      res.status(201).json({id});
    }catch(e){console.error("[finance POST]",e.message);res.status(500).json({error:"Falha ao salvar registro."});}
  });
  router.delete("/entries/:id",async(req,res)=>{
    if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({error:"Identificador inválido."});
    try{const r=await db.query("DELETE FROM finance_entries WHERE id=$1 RETURNING id",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Registro não encontrado."});res.json({deleted:true});}
    catch(e){console.error("[finance DELETE]",e.message);res.status(500).json({error:"Falha ao excluir registro."});}
  });
}
async function initializeFinance(db){
 if(db)await db.query("CREATE TABLE IF NOT EXISTS finance_entries (id UUID PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('sale','expense')), amount_cents BIGINT NOT NULL CHECK(amount_cents > 0), entry_date DATE NOT NULL, product TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
}
module.exports={registerFinance,initializeFinance,validate,summary};
