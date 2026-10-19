// The provider must generate the same shape that is independently checked locally.
// The model selects source IDs. Preview text is copied by the server, never generated.
import {RAG_LIMITS as limits} from '../public/contracts.js';
export const groundedResponseFormat={
  type:'json_schema',
  json_schema:{
    name:'grounded_answer',strict:true,
    schema:{
      type:'object',additionalProperties:false,
      properties:{
        insufficientEvidence:{type:'boolean',description:'True only if the sources do not answer the question; then segments must be empty.'},
        segments:{
          type:'array',minItems:0,maxItems:limits.blocks,
          items:{
            type:'object',additionalProperties:false,
            properties:{
              text:{type:'string',minLength:1,maxLength:limits.blockChars,description:'A concise Spanish paragraph or list, without inline source markers.'},
              citations:{
                type:'array',minItems:1,maxItems:limits.citations,
                items:{
                  type:'object',additionalProperties:false,
                  properties:{
                    sourceId:{type:'string',enum:Array.from({length:limits.sources},(_,index)=>'F'+(index+1)),description:'The exact ID of an available source that supports this block.'},
                  },
                  required:['sourceId'],
                },
              },
            },
            required:['text','citations'],
          },
        },
      },
      required:['insufficientEvidence','segments'],
    },
  },
};
