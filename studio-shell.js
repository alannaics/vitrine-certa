(function(){
 const path=location.pathname;
 const current=path==="/catalog"?"catalog":path==="/finance"?"finance":path==="/tools"?"tools":"home";
 const links=[["/","home","◫","Visão geral"],["/catalog","catalog","▦","Explorar produtos"],["/finance","finance","◈","Financeiro"],["/tools","tools","✧","Ferramentas"]];
 const sidebar=document.createElement("aside");sidebar.className="vc-sidebar";
 const brand=document.createElement("a");brand.href="/";brand.className="vc-brand";brand.innerHTML='<span class="vc-brandmark">V</span><span><strong>vitrine certa<span style="color:#a79bff">.</span></strong><small>Affiliate workspace</small></span>';sidebar.append(brand);
 const section=document.createElement("div");section.className="vc-navigation";const caption=document.createElement("div");caption.className="vc-caption";caption.textContent="Seu workspace";section.append(caption);
 const nav=document.createElement("nav");nav.className="vc-nav";nav.setAttribute("aria-label","Navegação principal");
 for(const [href,id,icon,label] of links){const a=document.createElement("a");a.href=href;if(id===current){a.className="active";a.setAttribute("aria-current","page")}const ico=document.createElement("span");ico.className="vc-ico";ico.textContent=icon;a.append(ico,document.createTextNode(label));nav.append(a)}section.append(nav);sidebar.append(section);
 const foot=document.createElement("div");foot.className="vc-sidebar-foot";foot.textContent="Seu espaço para descobrir, organizar e crescer.";sidebar.append(foot);
 const main=document.querySelector("body > main");if(!main)return;
 const layout=document.createElement("div");layout.className="vc-layout";const workspace=document.createElement("div");workspace.className="vc-workspace";const top=document.createElement("div");top.className="vc-topbar";top.innerHTML='<span>Workspace <span class="vc-slash">/</span> <strong></strong></span><span class="vc-avatar" aria-hidden="true">VC</span>';top.querySelector("strong").textContent=current==="catalog"?"Explorar produtos":current==="finance"?"Financeiro":"Ferramentas";
 document.body.insertBefore(layout,main);layout.append(sidebar,workspace);workspace.append(top,main);
 const old=document.querySelector(".studio-toplinks");if(old)old.remove();
 const header=main.querySelector(":scope > header");if(header){const back=header.querySelector('a[href="/"]');if(back)back.remove()}
})();
