import {clamp} from './simulation.mjs';
export function summarizeWeather(doc,now=Date.now()) {
  const current=doc.current;
  if(!current || !Number.isFinite(current.temperature_2m)) throw Error('Weather reading is incomplete.');
  const validAt=Date.parse(current.time+'Z');
  if(!Number.isFinite(validAt)||now-validAt>2*3600000||validAt-now>300000) throw Error('Weather reading is stale.');
  const times=(doc.hourly?.time||[]).map(t=>Date.parse(t+'Z'));
  function sum(key,start,end,hours) {
    const series=doc.hourly[key]||[];
    const values=[];
    times.forEach((t,i)=>{
      const delta=(t-now)/3600000;
      if(delta>start && delta<=end && Number.isFinite(series[i])) values.push(series[i]);
    });
    return values.length>=Math.ceil(hours*.8)?values.reduce((a,b)=>a+b,0):null;
  }
  const rain6=sum('precipitation',-6,0,6),rain24=sum('precipitation',-24,0,24);
  const rain72=sum('precipitation',-72,0,72),et24=sum('et0_fao_evapotranspiration',-24,0,24);
  const forecastRain=sum('precipitation',0,24,24),forecastEt=sum('et0_fao_evapotranspiration',0,24,24);
  const complete=[rain6,rain24,rain72,et24].every(Number.isFinite);
  const wet=complete?clamp(.48*clamp(rain6/5,0,1)+.32*clamp(rain24/15,0,1)+.20*clamp(rain72/35,0,1),0,1):0;
  const dry=complete?clamp(et24/6,0,1)*(1-.68*wet):0;
  const net=clamp(dry-.92*wet,-1,1);
  return {validAt,fetchedAt:now,temperature:current.temperature_2m,humidity:current.relative_humidity_2m,
    wind:current.wind_speed_10m,rain6,rain24,rain72,et24,forecastRain,forecastEt,complete,
    delta:complete?clamp(net*.09,-.09,.09):0,
    label:!complete?'Partial weather coverage':wet>=dry+.18?'Weather favors softening':dry>=wet+.18?'Weather favors drying':'Limited weather shift'};
}
export async function fetchWeather(course) {
  const params=new URLSearchParams({
    latitude:course.latitude,longitude:course.longitude,timezone:'GMT',past_days:3,forecast_days:2,
    current:'temperature_2m,relative_humidity_2m,wind_speed_10m',
    hourly:'precipitation,et0_fao_evapotranspiration',wind_speed_unit:'kmh',precipitation_unit:'mm'
  });
  const response=await fetch('https://api.open-meteo.com/v1/forecast?'+params,{signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw Error('Weather provider returned '+response.status);
  return summarizeWeather(await response.json());
}
