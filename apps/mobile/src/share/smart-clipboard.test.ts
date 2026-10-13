import test from 'node:test';
import assert from 'node:assert/strict';
import {readSmartClipboard} from './smart-clipboard.ts';

test('one browser clipboard snapshot preserves both image and text',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 let reads=0;
 try {
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{read:async()=>{
   reads++;
   return [{types:['image/png','text/plain'],getType:async(type:string)=>type==='image/png' ? new Blob([Uint8Array.from([0,255])],{type:'image/png'}) : new Blob(['caption'],{type:'text/plain'})}];
  }}}});
  assert.deepEqual(await readSmartClipboard(),{text:'caption',image:{uri:'data:image/png;base64,AP8=',mimeType:'image/png',fileName:null}});
  assert.equal(reads,1);
 } finally {if(previous) Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');}
});
test('clipboard denial propagates instead of silently replacing content',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 try {
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{read:async()=>{throw new Error('Denied');}}}});
  await assert.rejects(readSmartClipboard(),/Denied/);
 } finally {if(previous) Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');}
});
