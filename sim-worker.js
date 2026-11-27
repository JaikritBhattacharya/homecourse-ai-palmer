import {simulate,makeDraws,pairedDifference} from './simulation.mjs';
self.onmessage=({data})=>{
  try {
    const {hole,grid,clubs,profiles,weatherDelta,model}=data;
    const searchDraws=makeDraws(model.search_trials,model.seed);
    // Final estimates use fresh draws after aim selection.
    const finalDraws=makeDraws(model.trials,model.seed+1);
    const results=[];
    for(let index=0;index<clubs.length;index++){
      const club=clubs[index];
      let aim=club.aim||0;
      if(data.optimizeAim){
        let best=Infinity;
        for(let offset=model.aim_search_degrees[0];offset<=model.aim_search_degrees[1];offset+=model.aim_step_degrees){
          const candidate=simulate({hole,grid,club:{...club,aim:offset},profiles,draws:searchDraws,weatherDelta});
          if(candidate.score<best){best=candidate.score;aim=offset;}
        }
      }
      results.push(simulate({hole,grid,club:{...club,aim},profiles,draws:finalDraws,weatherDelta,keepShots:true}));
      self.postMessage({type:'progress',completed:index+1,total:clubs.length});
    }
    const sorted=[...results].sort((a,b)=>a.score-b.score);
    const leader=sorted[0],runner=sorted[1];
    const gap=runner?pairedDifference(runner.scores,leader.scores):null;
    const recommended=leader.rates.unmapped<.75?leader.id:null;
    for(const row of results)row.delta=pairedDifference(results[0].scores,row.scores);
    for(const row of results)delete row.scores;
    self.postMessage({type:'result',rows:results,recommended,gap,trials:model.trials});
  }catch(error){self.postMessage({type:'error',error:error.message});}
};
