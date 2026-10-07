const demo = [
  {coin:"BTC", ticker:"KXBTC-DEMO", price:.42, prev:.37, mins:8, signal:"BUY YES", strength:84, reason:"Momentum + favorable price movement"},
  {coin:"ETH", ticker:"KXETH-DEMO", price:.67, prev:.69, mins:11, signal:"WATCH", strength:61, reason:"Price strong but momentum is fading"},
  {coin:"SOL", ticker:"KXSOL-DEMO", price:.73, prev:.65, mins:4, signal:"SELL / AVOID", strength:79, reason:"Price extended relative to recent movement"}
];

function money(x){return Math.round(x*100)+"¢"}
function render(){
  const grid=document.querySelector("#marketGrid");
  grid.innerHTML=demo.map(m=>{
    const d=((m.price-m.prev)/m.prev*100);
    const cls=d>0?"up":d<0?"down":"neutral";
    const sig=m.signal.includes("BUY")?"up":m.signal.includes("SELL")?"down":"neutral";
    return `<article class="card market">
      <div class="marketTop"><div><div class="coin">${m.coin}</div><div class="ticker">${m.ticker}</div></div><div class="muted">${m.mins}m left</div></div>
      <div class="price">${money(m.price)}</div>
      <div class="change ${cls}">${d>=0?"+":""}${d.toFixed(1)}% vs prior</div>
      <div class="signal"><strong class="${sig}">${m.signal}</strong><span class="strength">${m.strength}% strength</span></div>
    </article>`;
  }).join("");
  document.querySelector("#signalFeed").innerHTML=demo.map(m=>`<div class="feedItem"><b>${m.coin}: ${m.signal}</b><span>${m.reason} • ${m.strength}% signal strength • Demo data</span></div>`).join("");
}
function loadEndpoint(){document.querySelector("#endpoint").value=localStorage.getItem("kalshiSignalEndpoint")||""}
document.querySelector("#saveEndpoint").onclick=()=>{
  const v=document.querySelector("#endpoint").value.trim();
  localStorage.setItem("kalshiSignalEndpoint",v);
  document.querySelector("#endpointMsg").textContent=v?"Saved on this device.":"Cleared.";
};
document.querySelector("#notifyBtn").onclick=async()=>{
  if(!("Notification" in window)){alert("This browser does not support notifications.");return}
  const p=await Notification.requestPermission();
  document.querySelector("#notifyBtn").textContent=p==="granted"?"Alerts Enabled":"Alerts Not Enabled";
};
render(); loadEndpoint();
document.querySelector("#signals").textContent="Demo";
document.querySelector("#wins").textContent="—";
document.querySelector("#accuracy").textContent="—";
