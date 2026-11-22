const test = require("node:test");
const assert = require("node:assert/strict");
const {validate,summary} = require("./finance");
test("validate accepted commission",()=>{const e=validate({type:"sale",amount:12.34,date:"2026-11-21",product:"Produto A"});assert.equal(e.amount,1234)});
test("reject invalid amount",()=>assert.throws(()=>validate({type:"sale",amount:-1,date:"2026-11-21",product:"X"})));
test("reject unknown type",()=>assert.throws(()=>validate({type:"other",amount:1,date:"2026-11-21",product:"X"})));
test("compute net result",()=>{const r=summary([{type:"sale",amount_cents:30000,entry_date:"2026-11-21"},{type:"expense",amount_cents:18000,entry_date:"2026-11-21"}]);assert.equal(r.profit,120);assert.equal(r.roi,66.66666666666666)});
test("no expenses means no ROI",()=>assert.equal(summary([{type:"sale",amount_cents:1000,entry_date:"2026-11-21"}]).roi,null));

test("reject non-numeric or non-finite amounts",()=>{
 for(const amount of [0,NaN,Infinity,"12.00"])assert.throws(()=>validate({type:"sale",amount,date:"2026-11-21",product:"Produto"}));
});
test("summary sorts dates and preserves cent-based arithmetic",()=>{
 const rows=[{type:"expense",amount_cents:250,entry_date:"2026-11-21"},{type:"sale",amount_cents:1000,entry_date:"2026-11-20"},{type:"sale",amount_cents:500,entry_date:"2026-11-21"}];
 const result=summary(rows);
 assert.equal(result.sales,15);assert.equal(result.expenses,2.5);assert.equal(result.profit,12.5);assert.equal(result.roi,500);
 assert.deepEqual(result.daily.map(x=>x.date),["2026-11-20","2026-11-21"]);
});
test("empty financial records produce no fabricated ROI",()=>{
 const result=summary([]);assert.equal(result.sales,0);assert.equal(result.expenses,0);assert.equal(result.roi,null);assert.deepEqual(result.daily,[]);
});
