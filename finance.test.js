const test = require("node:test");
const assert = require("node:assert/strict");
const {validate,summary} = require("./finance");
test("validate accepted commission",()=>{const e=validate({type:"sale",amount:12.34,date:"2026-11-21",product:"Produto A"});assert.equal(e.amount,1234)});
test("reject invalid amount",()=>assert.throws(()=>validate({type:"sale",amount:-1,date:"2026-11-21",product:"X"})));
test("reject unknown type",()=>assert.throws(()=>validate({type:"other",amount:1,date:"2026-11-21",product:"X"})));
test("compute net result",()=>{const r=summary([{type:"sale",amount_cents:30000,entry_date:"2026-11-21"},{type:"expense",amount_cents:18000,entry_date:"2026-11-21"}]);assert.equal(r.profit,120);assert.equal(r.roi,66.66666666666666)});
test("no expenses means no ROI",()=>assert.equal(summary([{type:"sale",amount_cents:1000,entry_date:"2026-11-21"}]).roi,null));
