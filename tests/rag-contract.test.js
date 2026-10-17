import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateGroundedAnswer,createRagRepository} from '../src/rag.js';

const source={id:'F1',filename:'synthetic.txt',content:'El ciclista debe detenerse completamente ante una señal de alto.',position:0};
const segment={text:'Debe detenerse ante el alto.',citations:[{sourceId:'F1'}]};
const syntheticSource={id:'F1',filename:'manual-sintetico.txt',position:0,content:'En este manual ficticio, el ciclista debe detenerse completamente ante una señal de alto. Debe ceder el paso a los peatones que cruzan la vía. Debe mantener una distancia de tres pies respecto de los vehículos estacionados. Para cambiar de dirección debe avisar con una señal de mano. Estas reglas se describen únicamente como material sintético de prueba.'};
// Text adapted from the earlier authorized synthetic probe to the ID-only contract.
// This fixture is NOT a new live result and contains no user PDF text.
const referenceAnswer={insufficientEvidence:false,segments:[
  {text:'Según el texto, las obligaciones principales del ciclista son:\n1. Detenerse completamente ante una señal de alto.\n2. Ceder el paso a los peatones que cruzan la vía.\n3. Mantener una distancia de tres pies respecto de los vehículos estacionados.',citations:[
    {sourceId:'F1'},
  ]},
  {text:'Además, para cambiar de dirección debe avisar con una señal de mano.',citations:[{sourceId:'F1'}]},
]};
test('resumen sintético puede referenciar el mismo fragmento en distintos bloques sin copiar texto',()=>{
  const result=validateGroundedAnswer(JSON.stringify(referenceAnswer),[syntheticSource]);
  assert.equal(result.segments[0].citations.length,1);assert.equal(result.sources.length,1);
  assert.equal(result.segments[0].citations[0].quote,syntheticSource.content.slice(0,300));
});
test('resumen con referencias pasa por streaming y no acepta un identificador inventado',async()=>{
  const events=[],raw=JSON.stringify(referenceAnswer);
  const repository=createRagRepository({search:async()=>({matches:[syntheticSource],indexedSources:1})},async()=> (async function*(){for(let index=0;index<raw.length;index+=7)yield {choices:[{delta:{content:raw.slice(index,index+7)}}]};})(),{});
  const result=await repository.answer({body:{query:'Obligaciones',confirmExternalProcessing:true}},{},undefined,event=>events.push(event));
  assert.equal(events.length,2);assert.deepEqual(result.segments.map(s=>s.text),referenceAnswer.segments.map(s=>s.text));
  assert.deepEqual(events.map(e=>e.segment),result.segments);
  const forged=structuredClone(referenceAnswer);forged.segments[0].citations[0].sourceId='F99';
  assert.throws(()=>validateGroundedAnswer(JSON.stringify(forged),[syntheticSource]),error=>error.reason==='UNKNOWN_SOURCE');
});
test('regresión del modelo real: citas vacías se diagnostican como campos faltantes, no como texto inventado',()=>{
  const response={insufficientEvidence:false,segments:[{text:'Debe detenerse ante el alto.',citations:[{}]}]};
  assert.throws(()=>validateGroundedAnswer(JSON.stringify(response),[source]),error=>error.reason==='CITATION_FIELDS_MISSING'&&!error.message.includes(source.content));
});
test('formato JSON inválido, extracto no permitido y salida truncada tienen diagnósticos diferentes',async()=>{
  assert.throws(()=>validateGroundedAnswer('{',[source]),error=>error.reason==='INVALID_JSON');
  const wrong={...segment,citations:[{sourceId:'F1',quote:'Una cita que no existe en la fuente.'}]};
  assert.throws(()=>validateGroundedAnswer(JSON.stringify({insufficientEvidence:false,segments:[wrong]}),[source]),error=>error.reason==='CITATION_FIELDS_MISSING');
  const repository=createRagRepository({search:async()=>({matches:[source],indexedSources:1})},async()=> (async function*(){yield {choices:[{delta:{content:'{'},finish_reason:'length'}]};})(),{});
  await assert.rejects(repository.answer({body:{query:'Consulta',confirmExternalProcessing:true}},{}),{code:'RAG_OUTPUT_TRUNCATED'});
});
