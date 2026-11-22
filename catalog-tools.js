"use strict";
(function(){
const key="vc_catalog_favorites_v1";
const byId=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(n);
let saved={};try{const data=JSON.parse(localStorage.getItem(key)||"{}");if(data&&typeof data==="object"&&!Array.isArray(data))saved=data}catch{}
let results=[],showSaved=false,sort="relevance",freeOnly=false,limitPrice="";
const toolbar=document.createElement("div");toolbar.className="catalog-tools";toolbar.innerHTML='<div class="catalog-tools-row"><label class="catalog-tools-label">Organizar <select id="vcSort"><option value="relevance">Ordem da busca</option><option value="low">Menor preço</option><option value="high">Maior preço</option></select></label><label class="catalog-tools-label">Preço máximo <input id="vcMaxPrice" type="number" min="1" step="1" placeholder="R$ sem limite"></label><label class="catalog-tools-check"><input type="checkbox" id="vcFree"> Frete grátis</label><button id="vcFavorites" type="button" class="secondary">♡ Salvos (0)</button></div><p class="catalog-tools-hint">Filtros aplicados aos resultados carregados nesta página. Os favoritos ficam salvos somente neste navegador.</p>';
const form=byId("search");form.after(toolbar);
const grid=byId("grid"),status=byId("status");
function save(){try{localStorage.setItem(key,JSON.stringify(saved))}catch{status.textContent="O navegador não permitiu salvar favoritos."}}
function favoriteCount(){return Object.keys(saved).length}
function paint(){
 const button=byId("vcFavorites");button.textContent=(showSaved?"♥ Exibindo salvos (":"♡ Salvos (")+favoriteCount()+")";button.setAttribute("aria-pressed",String(showSaved));
 const list=showSaved?Object.values(saved):results;
 const filtered=list.filter(p=>(!freeOnly||p.freeShipping)&&(limitPrice===""||p.price!=null&&Number(p.price)<=Number(limitPrice)));
 if(sort==="low")filtered.sort((a,b)=>(a.price??Infinity)-(b.price??Infinity));
 if(sort==="high")filtered.sort((a,b)=>(b.price??-Infinity)-(a.price??-Infinity));
 grid.replaceChildren();
 for(const p of filtered){
   const article=card(p);const body=article.querySelector(".body");if(!body)continue;
   const fav=document.createElement("button");fav.type="button";fav.className="vc-fav";fav.textContent=saved[p.id]?"♥ Salvo":"♡ Salvar";fav.setAttribute("aria-pressed",String(Boolean(saved[p.id])));fav.setAttribute("aria-label",(saved[p.id]?"Remover dos salvos: ":"Salvar produto: ")+p.title);
   fav.addEventListener("click",()=>{if(saved[p.id])delete saved[p.id];else saved[p.id]={id:String(p.id),title:String(p.title),price:p.price,thumbnail:p.thumbnail,permalink:p.permalink,soldQuantity:p.soldQuantity,freeShipping:!!p.freeShipping};save();paint()});
   body.append(fav);grid.append(article);
 }
 if(showSaved)status.textContent=filtered.length+" produto(s) salvo(s) exibido(s) neste navegador.";
 else if(results.length)status.textContent=filtered.length+" de "+results.length+" produto(s) exibido(s) nesta página.";
 else if(!filtered.length&&showSaved)status.textContent="Nenhum favorito salvo. Pesquise produtos e toque em Salvar.";
 if(!filtered.length&&results.length)status.textContent="Nenhum produto corresponde aos filtros desta página.";
}
byId("vcSort").addEventListener("change",e=>{sort=e.target.value;paint()});
byId("vcMaxPrice").addEventListener("input",e=>{limitPrice=e.target.value;paint()});
byId("vcFree").addEventListener("change",e=>{freeOnly=e.target.checked;paint()});
byId("vcFavorites").addEventListener("click",()=>{showSaved=!showSaved;paint()});
window.vcCatalogResults=function(products){results=Array.isArray(products)?products:[];if(!showSaved)paint()};
window.vcCatalogClear=function(){results=[];if(!showSaved)grid.replaceChildren()};
window.vcCatalogRestore=function(){if(showSaved)paint()};
paint();
})();
