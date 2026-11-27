// Numerical counterpart of surface_identity/tee_optimizer.py.
// These are replaceable distance/lie costs, rather than fitted strokes-gained values.
export const YARD=.9144;
export const WIDTH_FRACTION=.22;
export const Z80=1.2815515655446004;
export const clamp=(value,lo,hi)=>Math.min(hi,Math.max(lo,value));
const stops=new Set([5,6,7,8,255]);
export function interpolate(x,knots,values) {
  if(x<=knots[0]) return values[0];
  for(let i=1;i<knots.length;i++) if(x<=knots[i])
    return values[i-1]+(x-knots[i-1])/(knots[i]-knots[i-1])*(values[i]-values[i-1]);
  return values.at(-1);
}
export function referenceRoll(club,profiles) {
  const curve=profiles.find(p=>p.profile===club.profile).roll_curve;
  return interpolate(club.carry,curve.map(p=>p[0]),curve.map(p=>p[1]));
}
export function baseHeading(hole,carry) {
  const xs=hole.route.map(p=>p[0]);
  const x=interpolate(carry,xs,hole.route.map(p=>p[1]));
  const y=interpolate(carry,xs,hole.route.map(p=>p[2]));
  return Math.atan2((y-hole.tee[1])*hole.pixel_m[1],(x-hole.tee[0])*hole.pixel_m[0]);
}
export function shotWidth(club) { return club.width ?? club.carry*WIDTH_FRACTION; }
export function expectedCost(distance,lie) {
  const knots=[0,20,50,100,150,200,250,350,500,700];
  const values=[1.7,2.4,2.65,2.85,3.04,3.25,3.58,4.04,4.62,5.45];
  const fairway=interpolate(distance,knots,values)+Math.max(distance-700,0)*.004;
  const adjustments={2:.20,5:.45,6:1.25,7:.85,8:.85,9:.55,255:.60};
  return 1+(lie===3 ? clamp(1.60+.027*distance,1.60,2.8) : fairway+(adjustments[lie]||0));
}
export function makeDraws(count,seed=20261108) {
  let state=seed>>>0;
  function random() {
    state=(state+0x6D2B79F5)>>>0;
    let t=state;
    t=Math.imul(t^(t>>>15),t|1);
    t^=t+Math.imul(t^(t>>>7),t|61);
    return ((t^(t>>>14))>>>0)/4294967296;
  }
  const draws=new Float64Array(count*3);
  for(let i=0;i<draws.length;i+=2) {
    const r=Math.sqrt(-2*Math.log(Math.max(1e-12,random()))),a=2*Math.PI*random();
    draws[i]=r*Math.cos(a);
    if(i+1<draws.length) draws[i+1]=r*Math.sin(a);
  }
  return draws;
}
export function simulate({hole,grid,club,profiles,draws,weatherDelta=0,keepShots=false}) {
  const count=draws.length/3;
  const scores=new Float64Array(count),rates={fairway:0,rough:0,green:0,sand:0,water:0,trees:0,built:0,native:0,unmapped:0};
  const names={1:'fairway',2:'rough',3:'green',5:'sand',6:'water',7:'trees',8:'built',9:'native',255:'unmapped'};
  const angle=baseHeading(hole,club.carry)+(club.aim||0)*Math.PI/180;
  const dx=Math.cos(angle),dy=Math.sin(angle),side=shotWidth(club)/(2*Z80);
  const [mx,my]=hole.pixel_m,[tx,ty]=hole.tee;
  const refRoll=referenceRoll(club,profiles),step=Math.min(mx,my)/YARD/2;
  const shots=[];
  let totalScore=0,totalRoll=0,totalDistance=0,totalRemaining=0;
  function sample(x,y) {
    const ix=Math.floor(x),iy=Math.floor(y);
    return ix<0||iy<0||ix>=grid.width||iy>=grid.height ? -1 : (iy*grid.width+ix)*4;
  }
  for(let i=0;i<count;i++) {
    const depth=Math.max(1,club.carry*(1+.05*draws[i*3])),lateral=side*draws[i*3+1];
    const gx=(depth*dx-lateral*dy)*YARD,gy=(depth*dy+lateral*dx)*YARD;
    const lx=tx+gx/mx,ly=ty+gy/my;
    const idx=sample(lx,ly);
    let lie=idx<0?255:grid.data[idx];
    const multiplier=clamp((idx<0?1:.73+grid.data[idx+1]/255*.78)+weatherDelta,.73,1.51);
    const friction=stops.has(lie)?0:lie===2?.55:lie===3?.65:lie===9?.35:1;
    const roll=refRoll*multiplier*friction*clamp(1+.30*draws[i*3+2],0,2);
    let traveled=0,x=lx,y=ly;
    const norm=Math.hypot(gx,gy),rx=gx/norm*YARD/mx,ry=gy/norm*YARD/my;
    for(let d=step;traveled<roll;d+=step) {
      traveled=Math.min(d,roll);
      x=lx+traveled*rx;y=ly+traveled*ry;
      const index=sample(x,y);
      lie=index<0?255:grid.data[index];
      if(stops.has(lie)) break;
    }
    const remaining=Math.hypot((x-hole.green[0])*mx,(y-hole.green[1])*my)/YARD;
    const distance=Math.hypot((x-tx)*mx,(y-ty)*my)/YARD;
    const score=expectedCost(remaining,lie);
    scores[i]=score;totalScore+=score;totalRoll+=traveled;totalDistance+=distance;totalRemaining+=remaining;
    rates[names[lie]||'unmapped']++;
    if(keepShots && i%10===0) shots.push([x,y,lie]);
  }
  for(const key in rates) rates[key]/=count;
  return {id:club.id,name:club.name,aim:club.aim||0,carry:club.carry,width:shotWidth(club),
    score:totalScore/count,meanRoll:totalRoll/count,meanTotal:totalDistance/count,
    remaining:totalRemaining/count,rates,scores,shots};
}
export function pairedDifference(a,b) {
  let sum=0,sq=0;
  for(let i=0;i<a.length;i++){const d=a[i]-b[i];sum+=d;sq+=d*d;}
  const mean=sum/a.length,variance=Math.max(0,(sq-a.length*mean*mean)/(a.length-1));
  return {mean,se:Math.sqrt(variance/a.length)};
}
