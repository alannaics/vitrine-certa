"use strict";
const express=require("express");
function registerCatalog(app,ensureToken){
 const router=express.Router(),cache=new Map();
 app.use("/api/catalog",router);
 router.get("/mercadolivre",async(req,res)=>{
  const q=String(req.query.q||"").trim().slice(0,90);
  const page=Math.max(1,Math.min(20,parseInt(req.query.page,10)||1));
  const limit=50;
  if(!q)return res.status(400).json({error:"Informe um termo de pesquisa."});
  const key=q.toLowerCase()+":"+page;
  const old=cache.get(key);
  if(old&&Date.now()-old.time<15*60*1000)return res.json({...old.payload,cached:true});
  try{
   let token=null,authIssue=null;
   try{token=await ensureToken()}catch(e){authIssue=e.message}
   const url=new URL("https://api.mercadolibre.com/sites/MLB/search");
   url.search=new URLSearchParams({q,limit:String(limit),offset:String((page-1)*limit)}).toString();
   const headers={Accept:"application/json","User-Agent":"VitrineCerta/1.0"};
   if(token)headers.Authorization="Bearer "+token;
   let response=await fetch(url,{headers});
   if((response.status===401||response.status===403)&&token){delete headers.Authorization;response=await fetch(url,{headers})}
   const data=await response.json().catch(()=>({}));
   if(!response.ok)return res.status(response.status===401||response.status===403?response.status:502).json({error:authIssue?"A conexão Mercado Livre precisa ser corrigida: "+authIssue+"; a busca pública também foi recusada (HTTP "+response.status+").":"A API do Mercado Livre recusou a busca (HTTP "+response.status+").",upstreamStatus:response.status});
   const products=(Array.isArray(data.results)?data.results:[]).map(p=>({
    id:String(p.id||""),title:String(p.title||""),price:Number.isFinite(Number(p.price))?Number(p.price):null,
    thumbnail:String(p.thumbnail||""),permalink:String(p.permalink||""),
    soldQuantity:p.sold_quantity==null?null:Number(p.sold_quantity),
    availableQuantity:p.available_quantity==null?null:Number(p.available_quantity),
    freeShipping:Boolean(p.shipping?.free_shipping),category:String(p.category_id||""),
    currency:String(p.currency_id||"BRL")
   })).filter(p=>p.id&&p.title&&p.permalink);
   const payload={products,count:products.length,page,pageSize:limit,total:Math.max(0,Number(data.paging?.total)||0),source:"Mercado Livre — API oficial de busca",ranking:"Ordem retornada pela busca; não é ranking comprovado de vendas.",updatedAt:new Date().toISOString()};
   if(cache.size>120)cache.clear();
   cache.set(key,{time:Date.now(),payload});
   res.json(payload);
  }catch(e){console.error("[catalog]",e.message);res.status(e.status===401?401:502).json({error:"Não foi possível carregar o catálogo: "+e.message})}
 });
}
module.exports={registerCatalog};
