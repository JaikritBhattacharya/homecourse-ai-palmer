import {baseHeading,shotWidth,referenceRoll,clamp,YARD} from './simulation.mjs';
import {fetchWeather} from './weather.mjs';
const $=id=>document.getElementById(id);
const colors=['#ffde64','#76e1ff','#ffa5d1','#c8f38b','#e7b8ff','#ffb378','#a6ffeb'];
const storeKey='hcai-palmer-shot-menu-v1';
const aimKey='hcai-palmer-shot-aims-v1';
const assets=new Map(),grids=new Map();
let data,hole,view='whole',clubs=[],aims={},weather=null,weatherBusy=false,worker=null,job=0,result=null;
let activeId=null,frameAssets=null,loadingToken=0,transform=null,zoom=1,pan={x:0,y:0},drag=null,hitTargets=[];
let frameBounds=null;
const canvas=$('mapCanvas'),ctx=canvas.getContext('2d');
const id=()=>crypto.randomUUID();
const percent=x=>Math.round(x*100)+'%';
const mm=x=>Number.isFinite(x)?x.toFixed(1)+' mm':'Unavailable';
function announce(message){$('globalStatus').textContent=message;}
function readStored(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
function persist(){try{localStorage.setItem(storeKey,JSON.stringify(clubs));localStorage.setItem(aimKey,JSON.stringify(aims));}catch{}}
function validClub(c){
  return c&&typeof c.id==='string'&&typeof c.name==='string'&&c.name.trim().length&&c.name.length<=60
    &&data.rollout_profiles.some(p=>p.profile===c.profile)&&Number.isFinite(c.carry)&&c.carry>=25&&c.carry<=400
    &&(c.width===null||Number.isFinite(c.width)&&c.width>=1&&c.width<=Math.min(200,1.9*c.carry))
    &&typeof c.enabled==='boolean';
}
function aimFor(c){const v=aims[hole.hole]?.[c.id];return Number.isFinite(v)&&Math.abs(v)<=180?v:0;}
function setAim(c,value){
  aims[hole.hole]={...aims[hole.hole],[c.id]:value};
  const input=document.querySelector('[data-aim="'+c.id+'"]');
  if(input)input.value=value;
  invalidate('Aim changed. Run again to compare the new targets.');
  persist();draw();
}
function enabledClubs(){return clubs.filter(c=>c.enabled).map(c=>({...c,aim:aimFor(c)}));}
function invalidate(message='Settings changed. Run again to compare your shots.'){
  job++;
  if(worker){worker.terminate();worker=null;}
  result=null;$('resultsSection').hidden=true;$('mapRecommendation').hidden=true;
  draw();
  $('cancelSimulation').hidden=true;
  $('simStatus').textContent=hole?.eligible?message:'Short hole · Tee-shot optimization is excluded.';
  updateRun();
}
function updateRun(){
  $('runSimulation').disabled=!hole?.eligible||!clubs.some(c=>c.enabled)||Boolean(worker);
  $('runSimulation').firstChild.textContent=worker?'Simulating… ':hole?.eligible?'Find my tee strategy ':'Short hole ';
}
function clubColor(c){return colors[Math.max(0,clubs.findIndex(x=>x.id===c.id))%colors.length];}
function field(label,element){
  const wrapper=document.createElement('label');wrapper.className='club-field';
  const span=document.createElement('span');span.textContent=label;wrapper.append(span,element);return wrapper;
}
function numberInput(value,label,min,max){
  const input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step='any';
  input.value=value;input.setAttribute('aria-label',label);return input;
}
function renderClubs(){
  $('clubList').replaceChildren();
  for(const c of clubs){
    const card=document.createElement('div');card.className='club-card'+(!c.enabled?' disabled':'');
    const top=document.createElement('div');top.className='club-top';
    const check=document.createElement('input');check.type='checkbox';check.checked=c.enabled;check.setAttribute('aria-label','Include '+c.name);
    const swatch=document.createElement('span');swatch.className='club-color';swatch.style.background=clubColor(c);
    const name=document.createElement('input');name.className='club-name';name.value=c.name;name.maxLength=60;name.setAttribute('aria-label','Shot name');
    const remove=document.createElement('button');remove.className='remove-club';remove.textContent='×';remove.setAttribute('aria-label','Remove '+c.name);
    top.append(check,swatch,name,remove);
    const fields=document.createElement('div');fields.className='club-fields';
    const carry=numberInput(c.carry,c.name+' carry in yards',25,400);
    const width=numberInput(c.width??'',c.name+' width in yards',1,Math.min(200,1.9*c.carry));width.placeholder=(.22*c.carry).toFixed(1);
    const profile=document.createElement('select');profile.setAttribute('aria-label',c.name+' rollout reference');
    for(const category of ['Woods','Hybrids','Irons','Utility']){
      const group=document.createElement('optgroup');group.label=category;
      data.rollout_profiles.filter(p=>p.category===category).forEach(p=>{
        const option=document.createElement('option');option.value=p.profile;
        option.textContent=p.name+(p.is_proxy?' (proxy)':'');group.append(option);
      });
      profile.append(group);
    }
    profile.value=c.profile;
    const referenceNote=document.createElement('p');referenceNote.className='reference-note';
    function updateReferenceNote(){
      const reference=data.rollout_profiles.find(p=>p.profile===c.profile);
      referenceNote.textContent=referenceRoll(c,data.rollout_profiles).toFixed(1)+' yd reference roll · '+
        (reference.is_proxy?reference.source_club+' proxy':'Published '+reference.source_club+' curve');
    }
    updateReferenceNote();
    const aim=numberInput(aimFor(c),c.name+' aim in degrees',-180,180);aim.dataset.aim=c.id;aim.disabled=!hole.eligible;
    fields.append(field('Carry · yd',carry),field('Width · yd',width),field('Roll reference',profile),field('Aim · degrees',aim));
    function changed(){updateReferenceNote();invalidate();persist();draw();}
    check.onchange=()=>{c.enabled=check.checked;card.classList.toggle('disabled',!c.enabled);changed();};
    name.onchange=()=>{c.name=name.value.trim()||c.name;name.value=c.name;persist();renderClubs();invalidate();};
    carry.onchange=()=>{
      const v=carry.valueAsNumber;
      if(!Number.isFinite(v)||v<25||v>400){carry.value=c.carry;return;}
      c.carry=v;if(c.width>Math.min(200,1.9*v))c.width=null;
      width.value=c.width??'';width.max=Math.min(200,1.9*v);width.placeholder=(.22*v).toFixed(1);changed();
    };
    width.onchange=()=>{
      const v=width.valueAsNumber;
      if(width.validity.badInput||width.value!==''&&(!Number.isFinite(v)||v<1||v>Math.min(200,1.9*c.carry))){width.value=c.width??'';return;}
      c.width=width.value===''?null:v;changed();
    };
    profile.onchange=()=>{c.profile=profile.value;changed();};
    aim.onchange=()=>{
      const v=aim.valueAsNumber;
      if(!Number.isFinite(v)||Math.abs(v)>180){aim.value=aimFor(c);return;}
      setAim(c,v);
    };
    remove.onclick=()=>{
      clubs=clubs.filter(x=>x.id!==c.id);
      for(const entries of Object.values(aims))delete entries[c.id];
      activeId=null;persist();renderClubs();invalidate();draw();
    };
    card.append(top,fields,referenceNote);$('clubList').append(card);
  }
}
function renderNav(){
  const back=hole.hole>9;$('frontNine').classList.toggle('active',!back);$('backNine').classList.toggle('active',back);
  $('holeList').replaceChildren();
  data.holes.filter(h=>(h.hole>9)===back).forEach(h=>{
    const b=document.createElement('button');b.className='hole-button'+(h.hole===hole.hole?' active':'');
    b.setAttribute('aria-label','Hole '+h.hole+', '+h.yards+' yards');b.setAttribute('aria-current',h.hole===hole.hole?'page':'false');
    const n=document.createElement('span');n.className='hole-num';n.textContent=h.hole;
    const label=document.createElement('span');label.className='hole-label';label.textContent='Hole '+h.hole;
    const yards=document.createElement('span');yards.className='hole-length';yards.textContent=h.yards+' yd';
    b.append(n,label,yards);b.onclick=()=>selectHole(h.hole);$('holeList').append(b);
  });
}
async function image(path){
  if(!assets.has(path) && assets.size>=15){const oldest=[...assets.keys()].find(key=>!key.startsWith('grid-'));if(oldest)assets.delete(oldest);}
  if(!assets.has(path))assets.set(path,new Promise((resolve,reject)=>{
    const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>{assets.delete(path);reject(Error('Could not load course image.'));};img.src='assets/'+path;
  }));
  return assets.get(path);
}
async function loadFrame(){
  const token=++loadingToken;frameAssets=null;drag=null;hitTargets=[];transform=null;$('mapLoading').hidden=false;
  const prefix=hole.frames[view].prefix;
  try{
    const [aerial,heat,outlines]=await Promise.all([image(prefix+'.jpg'),image(prefix+'-heat.png'),image(prefix+'-outlines.png')]);
    if(token!==loadingToken)return;
    frameAssets={aerial,heat,outlines};frameBounds=null;zoom=1;pan={x:0,y:0};draw();
    $('mapLoading').hidden=true;
  }catch(error){if(token===loadingToken){$('mapLoading').textContent=error.message;announce(error.message);}}
}
async function gridFor(selected){
  if(!grids.has(selected.hole))grids.set(selected.hole,(async()=>{
    const img=await image('grid-'+selected.hole+'.png');
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
    const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
    return {width:img.width,height:img.height,data:g.getImageData(0,0,img.width,img.height).data};
  })().catch(e=>{grids.delete(selected.hole);throw e;}));
  // Retain only the active grid on memory-constrained phones.
  if(grids.size>1){const old=[...grids.keys()].find(k=>k!==selected.hole);grids.delete(old);assets.delete('grid-'+old+'.png');}
  return grids.get(selected.hole);
}
async function selectHole(n){
  if(!data.holes.some(h=>h.hole===n))return;
  hole=data.holes.find(h=>h.hole===n);view='whole';activeId=null;
  $('wholeView').classList.add('active');$('greenView').classList.remove('active');
  $('holeEyebrow').textContent='PALMER / HOLE '+String(n).padStart(2,'0');
  $('holeTitle').textContent='Hole '+n+' · '+hole.yards+' yd';
  $('mapCaption').textContent='Tee below · Green above · Drag a target to aim';
  $('mapNote').textContent='Terrain baseline · Aerial '+data.imagery_dates.map(t=>t.slice(0,10)).join(', ')+' · Approximate mapped tee';
  history.replaceState(null,'','?hole='+n);
  renderNav();renderClubs();invalidate('5,000 final shots per selected variant');
  announce('');await loadFrame();
}
function rawToView(x,y){
  const theta=-Math.PI/2-Math.atan2(hole.green[1]-hole.tee[1],hole.green[0]-hole.tee[0]);
  const scale=hole.shot.pixels_per_yard*(hole.pixel_m[0]+hole.pixel_m[1])/2/YARD;
  const dx=x-hole.tee[0],dy=y-hole.tee[1];
  return [hole.shot.tee[0]+scale*(Math.cos(theta)*dx-Math.sin(theta)*dy),
    hole.shot.tee[1]+scale*(Math.sin(theta)*dx+Math.cos(theta)*dy)];
}
function shotGeometry(club){
  const angle=baseHeading(hole,club.carry)+(club.aim||0)*Math.PI/180;
  const target=rawToView(hole.tee[0]+Math.cos(angle)*club.carry*YARD/hole.pixel_m[0],
    hole.tee[1]+Math.sin(angle)*club.carry*YARD/hole.pixel_m[1]);
  const tee=hole.shot.tee,heading=Math.atan2(target[1]-tee[1],target[0]-tee[0]);
  return {target,tee,heading,radius:club.carry*hole.shot.pixels_per_yard,
    outer:(club.carry+referenceRoll(club,data.rollout_profiles)*(1+(weather?.delta||0)))*hole.shot.pixels_per_yard,
    half:Math.asin(Math.min(.98,shotWidth(club)/(2*club.carry)))};
}
function mappedPoint(x,y){return [(x-transform.cx)*transform.scale+transform.w/2+pan.x,(y-transform.cy)*transform.scale+transform.h/2+pan.y];}
function pointerPoint(e){const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
function unmapPoint(p){return {x:(p.x-transform.w/2-pan.x)/transform.scale+transform.cx,y:(p.y-transform.h/2-pan.y)/transform.scale+transform.cy};}
function draw(){
  if(!frameAssets||!data)return;
  const r=$('mapStage').getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#d9e0d4';ctx.fillRect(0,0,r.width,r.height);
  let left=0,top=0,right=frameAssets.aerial.width,bottom=frameAssets.aerial.height;
  if(view==='whole'&&!frameBounds){
    const points=[hole.shot.tee,hole.shot.green,...hole.shot.route.map(p=>p.point)];
    if(hole.eligible)for(const c of enabledClubs()){
      const g=shotGeometry(c);points.push(g.target);
      for(const a of [g.heading-g.half,g.heading+g.half])
        points.push([g.tee[0]+g.outer*Math.cos(a),g.tee[1]+g.outer*Math.sin(a)]);
    }
    left=Math.min(...points.map(p=>p[0]))-100;right=Math.max(...points.map(p=>p[0]))+100;
    top=Math.min(...points.map(p=>p[1]))-62;bottom=Math.max(...points.map(p=>p[1]))+62;
    frameBounds={left,top,right,bottom};
  }
  if(frameBounds)({left,top,right,bottom}=frameBounds);
  const scale=Math.min(r.width/(right-left),r.height/(bottom-top))*zoom;
  transform={cx:(left+right)/2,cy:(top+bottom)/2,scale,w:r.width,h:r.height};
  const [ox,oy]=mappedPoint(0,0);
  ctx.save();ctx.translate(ox,oy);ctx.scale(scale,scale);
  ctx.drawImage(frameAssets.aerial,0,0);
  if($('heatToggle').checked)ctx.drawImage(frameAssets.heat,0,0);
  if($('outlineToggle').checked)ctx.drawImage(frameAssets.outlines,0,0);
  ctx.restore();
  hitTargets=[];
  const leader=result?.rows.find(row=>row.id===result.recommended);
  const recommendedClub=leader?clubs.find(c=>c.id===leader.id):null;
  $('mapRecommendation').hidden=view!=='whole'||!recommendedClub;
  if(view!=='whole')return;
  if(recommendedClub){
    $('mapRecommendedClub').textContent=leader.name;
    const side=Math.abs(leader.aim)<.05?'On route':Math.abs(leader.aim).toFixed(1)+'° '+(leader.aim>0?'right':'left')+' of route';
    $('mapRecommendedAim').textContent=side+' · '+Math.round(leader.carry)+' yd carry';
  }
  const active=result?.rows.find(c=>c.id===(activeId||result.recommended));
  if(active&&$('cloudToggle').checked){
    ctx.save();ctx.globalAlpha=.28;
    for(const [x,y] of active.shots){const p=rawToView(x,y);const [cx,cy]=mappedPoint(...p);ctx.beginPath();ctx.arc(cx,cy,1.25,0,Math.PI*2);ctx.fillStyle=clubColor(active);ctx.fill();}
    ctx.restore();
  }
  if(hole.eligible)for(const c of enabledClubs()){
    const g=shotGeometry(c),[tx,ty]=mappedPoint(...g.tee),radius=g.radius*scale,outer=g.outer*scale;
    const color=clubColor(c);
    // Dotted rollout boundary, with transparent interior.
    ctx.save();ctx.globalAlpha=.60;ctx.strokeStyle=color;ctx.lineWidth=.85;ctx.lineCap='round';ctx.setLineDash([.3,4]);
    const start=g.heading-g.half,end=g.heading+g.half;
    const path=new Path2D();path.moveTo(tx+radius*Math.cos(start),ty+radius*Math.sin(start));
    path.lineTo(tx+outer*Math.cos(start),ty+outer*Math.sin(start));path.arc(tx,ty,outer,start,end);
    path.lineTo(tx+radius*Math.cos(end),ty+radius*Math.sin(end));ctx.stroke(path);
    ctx.restore();
    ctx.save();ctx.globalAlpha=.68;
    ctx.beginPath();ctx.arc(tx,ty,radius,start,end);
    ctx.strokeStyle=color;ctx.lineWidth=1.15;ctx.stroke();ctx.restore();
    const [cx,cy]=mappedPoint(...g.target);
    let handleX=cx,step=0;
    while(hitTargets.some(t=>Math.hypot(t.x-handleX,t.y-cy)<17)){
      step++;handleX=cx+Math.ceil(step/2)*19*(step%2?1:-1);
    }
    if(handleX!==cx){ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(handleX,cy);ctx.strokeStyle=color;ctx.lineWidth=.85;ctx.stroke();}
    ctx.beginPath();ctx.arc(handleX,cy,4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#163c2c';ctx.lineWidth=.8;ctx.stroke();
    hitTargets.push({x:handleX,y:cy,club:c});
  }
  if(recommendedClub){
    const g=shotGeometry({...recommendedClub,aim:leader.aim});
    const [tx,ty]=mappedPoint(...g.tee),[x,y]=mappedPoint(...g.target);
    ctx.save();ctx.lineCap='round';ctx.strokeStyle='#40db8b';ctx.lineWidth=1;
    ctx.globalAlpha=.55;ctx.setLineDash([3,7]);
    ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(x,y);ctx.stroke();
    ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.beginPath();ctx.arc(x,y,10,0,2*Math.PI);ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.stroke();
    ctx.strokeStyle='#11834e';ctx.lineWidth=1.6;ctx.stroke();
    ctx.beginPath();ctx.moveTo(x-4,y);ctx.lineTo(x+4,y);ctx.moveTo(x,y-4);ctx.lineTo(x,y+4);ctx.stroke();
    ctx.restore();
  }
  for(const [label,p] of [['T',hole.shot.tee],['G',hole.shot.green]]){
    const [x,y]=mappedPoint(...p);ctx.beginPath();ctx.arc(x,y,9,0,Math.PI*2);ctx.fillStyle='#173c2e';ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=1.3;ctx.stroke();
    ctx.fillStyle='white';ctx.font='bold 10px sans-serif';ctx.textAlign='center';ctx.fillText(label,x,y+3.5);
  }
}
canvas.addEventListener('pointerdown',e=>{
  if(e.button!==0||!e.isPrimary||!transform)return;
  const p=pointerPoint(e);
  const target=hitTargets.reduce((best,t)=>!best||Math.hypot(t.x-p.x,t.y-p.y)<Math.hypot(best.x-p.x,best.y-p.y)?t:best,null);
  if(target&&Math.hypot(target.x-p.x,target.y-p.y)<17){
    const world=unmapPoint(p),tee=hole.shot.tee;
    drag={type:'aim',club:target.club,start:Math.atan2(world.y-tee[1],world.x-tee[0]),aim:aimFor(target.club),pointer:e.pointerId};
  }else drag={type:'pan',start:p,pan:{...pan},pointer:e.pointerId};
  canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';
});
canvas.addEventListener('pointermove',e=>{
  const p=pointerPoint(e);
  if(!drag){canvas.style.cursor=hitTargets.some(t=>Math.hypot(t.x-p.x,t.y-p.y)<17)?'grab':'crosshair';return;}
  if(e.pointerId!==drag.pointer)return;
  if(drag.type==='pan'){pan={x:drag.pan.x+p.x-drag.start.x,y:drag.pan.y+p.y-drag.start.y};draw();}
  else{
    const w=unmapPoint(p),t=hole.shot.tee;
    const a=(drag.aim+(Math.atan2(w.y-t[1],w.x-t[0])-drag.start)*180/Math.PI+720)%360;
    setAim(drag.club,Math.round((a>=180?a-360:a)*10)/10);
  }
});
canvas.addEventListener('lostpointercapture',()=>{drag=null;canvas.style.cursor='crosshair';});
canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=clamp(zoom*(e.deltaY<0?1.12:.89),.75,4);draw();},{passive:false});
$('zoomIn').onclick=()=>{zoom=clamp(zoom*1.2,.75,4);draw();};
$('zoomOut').onclick=()=>{zoom=clamp(zoom/1.2,.75,4);draw();};
$('fitMap').onclick=()=>{zoom=1;pan={x:0,y:0};draw();};
for(const v of ['whole','green'])$(v+'View').onclick=()=>{
  view=v;zoom=1;pan={x:0,y:0};
  $('wholeView').classList.toggle('active',v==='whole');$('greenView').classList.toggle('active',v==='green');
  $('mapCaption').textContent=v==='green'?'Green close-up · Same heatmap scale':'Tee below · Green above · Drag a target to aim';
  loadFrame();
};
for(const name of ['heatToggle','outlineToggle','cloudToggle'])$(name).onchange=draw;
$('addClub').onclick=()=>{
  clubs.push({id:id(),name:'New shot',profile:'driver',carry:260,width:null,enabled:true});
  renderClubs();persist();invalidate();draw();
  const names=document.querySelectorAll('.club-name');names[names.length-1].focus();names[names.length-1].select();
};
$('frontNine').onclick=()=>selectHole(1);$('backNine').onclick=()=>selectHole(10);
$('searchAim').onchange=()=>invalidate();
$('cancelSimulation').onclick=()=>{invalidate('Simulation cancelled.');draw();};
$('runSimulation').onclick=async()=>{
  if(!hole?.eligible||!clubs.some(c=>c.enabled))return;
  if(weather&&Date.now()-weather.validAt>2*3600000){weather=null;renderWeather();}
  const selected=hole,bag=enabledClubs();
  invalidate('Loading the surface model…');const token=job;
  $('runSimulation').disabled=true;
  try{
    const grid=await gridFor(selected);
    if(token!==job)return;
    $('cancelSimulation').hidden=false;
    worker=new Worker('sim-worker.js',{type:'module'});updateRun();
    $('simStatus').textContent='Searching club and aim combinations…';
    const started=performance.now(),weatherAt=weather?.validAt||null,delta=weather?.delta||0,optimizeAim=$('searchAim').checked;
    worker.onmessage=({data:r})=>{
      if(token!==job)return;
      if(r.type==='progress'){$('simStatus').textContent='Compared '+r.completed+' of '+r.total+' shot variants…';return;}
      worker.terminate();worker=null;updateRun();$('cancelSimulation').hidden=true;
      if(r.type==='error'){$('simStatus').textContent=r.error;return;}
      result={...r,weatherAt,delta,optimizeAim,hole:selected.hole,seconds:(performance.now()-started)/1000};
      for(const row of result.rows)aims[hole.hole]={...aims[hole.hole],[row.id]:row.aim};
      activeId=r.recommended||r.rows.slice().sort((a,b)=>a.score-b.score)[0].id;
      persist();renderClubs();renderResults();draw();
      if(view==='whole')$('mapStage').scrollIntoView({behavior:'smooth',block:'center'});
      $('simStatus').textContent='Complete · '+r.trials.toLocaleString()+' final shots per variant · '+result.seconds.toFixed(1)+'s';
    };
    worker.onerror=()=>{if(token===job){invalidate('Simulation could not run. Please retry.');draw();}};
    worker.postMessage({hole:selected,grid,clubs:bag,profiles:data.rollout_profiles,weatherDelta:delta,model:data.model,optimizeAim});
  }catch(e){if(token===job){$('simStatus').textContent=e.message;updateRun();}}
};
function renderResults(){
  if(!result)return;
  $('resultsSection').hidden=false;
  const leader=result.rows.find(r=>r.id===result.recommended);
  $('recommendation').textContent=leader?'Explore '+leader.name:'Mapped coverage is too limited to recommend a shot';
  const close=result.gap&&result.gap.mean<1.96*result.gap.se;
  $('resultBadge').textContent=close?'Close model call':leader?.rates.unmapped>=.30?'Limited mapped coverage':'Model estimate';
  $('resultDetail').textContent=(result.optimizeAim?'Aim search within ±30° of the route. ':'Compared your current aims. ')+
    (result.weatherAt?'Weather model as of '+formatTime(result.weatherAt)+'.':'Baseline rollout; current weather unavailable.')+
    ' '+result.rows.length+' variants · '+result.trials.toLocaleString()+' final shots each.';
  $('resultCards').replaceChildren();$('resultsBody').replaceChildren();
  for(const row of [...result.rows].sort((a,b)=>a.score-b.score)){
    const card=document.createElement('article');card.className='result-card'+(row.id===result.recommended?' winner':'');
    const name=document.createElement('span');name.className='shot-heading';name.textContent=row.name;
    const score=document.createElement('strong');score.textContent=row.score.toFixed(2);
    const cost=document.createElement('span');cost.textContent='estimated strokes to finish';
    const details=document.createElement('p');details.className='muted';details.style.fontSize='13px';
    details.textContent=percent(row.rates.fairway)+' fairway · '+row.aim.toFixed(1)+'° aim';
    const show=document.createElement('button');show.type='button';show.textContent='View shot pattern';
    show.onclick=()=>{activeId=row.id;if(view==='green')$('wholeView').click();else draw();$('mapStage').scrollIntoView({behavior:'smooth',block:'center'});};
    card.append(name,score,cost,details,show);$('resultCards').append(card);
    const tr=document.createElement('tr');if(row.id===result.recommended)tr.className='selected';
    const other=row.rates.sand+row.rates.water+row.rates.trees+row.rates.built+row.rates.native;
    const cells=[row.name,row.aim.toFixed(1)+'°',row.score.toFixed(2),percent(row.rates.fairway),percent(row.rates.rough),
      percent(other),percent(row.rates.unmapped),row.meanRoll.toFixed(1)+' yd',Math.round(row.remaining)+' yd'];
    cells.forEach((value,i)=>{const cell=document.createElement(i===0?'th':'td');if(i===0)cell.scope='row';cell.textContent=value;tr.append(cell);});
    $('resultsBody').append(tr);
  }
}
function formatTime(value){return new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
function renderWeather(){
  $('weatherValues').replaceChildren();
  $('weatherHeading').textContent=weather?weather.label:'Weather temporarily unavailable';
  $('weatherTime').textContent=weather?'Model as of '+formatTime(weather.validAt)+' · Refreshes every 15 min':'Baseline rollout is active. Use Refresh weather to retry.';
  if(!weather)return;
  for(const [value,label] of [[weather.temperature.toFixed(0)+'°C','Course model'],[mm(weather.rain24),'Rain · past 24h'],[mm(weather.et24),'Reference ET₀ · 24h'],[mm(weather.forecastRain),'Rain · next 24h']]){
    const el=document.createElement('div');el.className='weather-number';el.textContent=value;
    const small=document.createElement('small');small.textContent=label;el.append(small);$('weatherValues').append(el);
  }
}
async function refreshWeather(){
  if(weatherBusy||!data)return;
  weatherBusy=true;$('refreshWeather').disabled=true;$('refreshWeather').textContent='Refreshing…';
  const previous=weather;
  try{weather=await fetchWeather(data);}
  catch{if(!weather||Date.now()-weather.validAt>2*3600000)weather=null;}
  finally{
    weatherBusy=false;$('refreshWeather').disabled=false;$('refreshWeather').textContent='Refresh weather';renderWeather();
    if((previous?.delta||0)!==(weather?.delta||0)||(previous?.validAt||null)!==(weather?.validAt||null)){
      invalidate('Weather updated. Run again to include this reading.');draw();
    }
  }
}
$('refreshWeather').onclick=refreshWeather;
$('methodButton').onclick=()=>$('methodDialog').showModal();
$('closeMethod').onclick=()=>$('methodDialog').close();
$('methodDialog').addEventListener('click',e=>{if(e.target===$('methodDialog'))$('methodDialog').close();});
new ResizeObserver(()=>draw()).observe($('mapStage'));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&data&&(!weather||Date.now()-weather.fetchedAt>15*60000))refreshWeather();});
setInterval(()=>{if(!document.hidden)refreshWeather();},15*60000);
async function init(){
  try{
    const response=await fetch('assets/course.json');if(!response.ok)throw Error('Course package unavailable.');
    data=await response.json();
    const stored=readStored(storeKey,null);
    clubs=Array.isArray(stored)&&stored.every(validClub)&&new Set(stored.map(c=>c.id)).size===stored.length?stored:
      data.clubs.map(c=>({id:id(),name:c.name,profile:c.profile,carry:c.carry,width:null,enabled:true}));
    const savedAims=readStored(aimKey,{});
    aims=savedAims&&typeof savedAims==='object'&&!Array.isArray(savedAims)?savedAims:{};
    $('methodContent').innerHTML='<h3>Relative terrain tendencies</h3><p>Saved terrain drying and water-retention responses are standardized separately within fairway, rough and green across all 18 holes. The heatmap is a terrain baseline, with aerial imagery dated '+data.imagery_dates.join(', ')+'. These colors are inferred tendencies; mechanical firmness has not been field-validated.</p>'+
      '<h3>Live weather context</h3><p>Open-Meteo supplies current modeled weather, recent precipitation and FAO reference evapotranspiration. The page checks for updates every 15 minutes while open. A bounded weather response adjusts simulated rollout by at most ±0.09 of the rollout multiplier. The terrain baseline stays dated. Irrigation, local rootzone construction and grass varieties remain unknown.</p>'+
      '<h3>Shot and aim simulation</h3><p>Each shot uses your carry and width. Lateral misses follow a normal distribution whose middle 80% spans the entered width. Carry standard deviation is 5% of carry. Search evaluates 25 aim angles across ±30° with 1,200 trials each, then estimates the selected aim with 5,000 fresh trials. This is a finite aim search.</p>'+
      '<h3>Estimated stroke costs</h3><p>The replaceable distance-and-lie scoring model includes assumed recovery costs for hazards and unmapped finishes. It has not been calibrated as a personalized strokes-gained model. Recommendations are withheld when at least 75% of the modeled leader’s finishes are unmapped. Short holes under 250 yards are excluded when explicit par is unavailable.</p>'+
      '<h3>Rollout and course data</h3><p>Rollout uses the existing Longleaf TrackMan-informed table, adjusted by mapped surface and weather. The selector includes woods, hybrids, irons and a driving iron. Clubs absent from the published table are labeled as proxies and show their source curve. Modeled roll stops at mapped hazards. Named stingers and teed-down shots use your distances with the chosen reference; trajectory-specific launch and spin are not yet modeled.</p>'+
      '<p><a href="https://longleafgfc.com/wp-content/uploads/sites/9351/2024/02/Longleaf-Tee-System.pdf" target="_blank" rel="noopener">Longleaf rollout reference</a> · <a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener">Weather documentation</a></p>'+
      '<h3>Credits and privacy</h3><p>USDA NAIP aerial imagery; OpenStreetMap contributors for mapped course features; user-reviewed surface outlines. Shot menus are stored on your device. The weather provider receives a request for the course coordinates. Simulation runs in your browser.</p><p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap attribution and license</a></p>';
    const requested=Number(new URLSearchParams(location.search).get('hole'));
    await selectHole(data.holes.some(h=>h.hole===requested)?requested:1);
    refreshWeather();
  }catch(e){announce(e.message);$('mapLoading').textContent=e.message;$('runSimulation').disabled=true;}
}
init();
