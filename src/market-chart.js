/* APEX OHLC aggregation from observed market price points only. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.ApexMarketChart=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function buildCandles(points,{intervalMs=60000,limit=40}={}){
 if(!Array.isArray(points)||!points.length)return [];
 if(!Number.isFinite(intervalMs)||intervalMs<=0)throw new Error('intervalMs must be positive');
 const ordered=points.filter(p=>p&&Number.isFinite(p.ts)&&Number.isFinite(p.price)&&p.price>0).slice().sort((a,b)=>a.ts-b.ts),bars=[];
 for(const p of ordered){const time=Math.floor(p.ts/intervalMs)*intervalMs;let b=bars[bars.length-1];if(!b||b.time!==time){b={time,o:p.price,h:p.price,l:p.price,c:p.price};bars.push(b)}else{b.h=Math.max(b.h,p.price);b.l=Math.min(b.l,p.price);b.c=p.price}}
 return bars.slice(-Math.max(1,Math.floor(limit)));
}
return {buildCandles};
});