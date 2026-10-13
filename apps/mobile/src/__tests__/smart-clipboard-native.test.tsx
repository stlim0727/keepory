const mockHasImage = jest.fn();
const mockGetImage = jest.fn();
const mockGetText = jest.fn();
const mockWrite = jest.fn();
jest.mock('expo-clipboard',()=>({hasImageAsync:()=>mockHasImage(),getImageAsync:(options:unknown)=>mockGetImage(options),getStringAsync:()=>mockGetText()}));
jest.mock('expo-file-system',()=>({Paths:{cache:'file:///cache'},File:jest.fn().mockImplementation(()=>({uri:'file:///cache/clipboard.png',write:(bytes:Uint8Array)=>mockWrite(bytes)}))}));
import {readSmartClipboard} from '@/share/smart-clipboard.native';
beforeEach(()=>{jest.clearAllMocks();mockGetText.mockResolvedValue('caption');});
it('waits for cache bytes before handing an image to the capture flow',async()=>{
 let resolve!:()=>void;
 mockHasImage.mockResolvedValue(true);
 mockGetImage.mockResolvedValue({data:'data:image/png;base64,AP8='});
 mockWrite.mockImplementation(()=>new Promise<void>(done=>{resolve=done;}));
 let complete=false;
 const capture=readSmartClipboard().then(value=>{complete=true;return value;});
 await Promise.resolve();await Promise.resolve();
 expect(complete).toBe(false);
 expect(mockGetImage).toHaveBeenCalledWith({format:'png'});
 expect(mockWrite).toHaveBeenCalledWith(Uint8Array.from([0,255]));
 resolve();
 expect(await capture).toMatchObject({text:'caption',image:{uri:'file:///cache/clipboard.png',mimeType:'image/png'}});
});
it('plain text needs no image write and clipboard denial propagates',async()=>{
 mockHasImage.mockResolvedValue(false);
 expect(await readSmartClipboard()).toEqual({text:'caption',image:undefined});
 expect(mockWrite).not.toHaveBeenCalled();
 mockHasImage.mockRejectedValue(new Error('Denied'));
 await expect(readSmartClipboard()).rejects.toThrow('Denied');
});

it('reads native image bytes without browser base64 globals', async () => {
 const originalAtob = globalThis.atob;
 const originalBtoa = globalThis.btoa;
 Reflect.deleteProperty(globalThis, 'atob');
 Reflect.deleteProperty(globalThis, 'btoa');
 try {
  mockHasImage.mockResolvedValue(true);
  const bytes = Uint8Array.from({ length: 128 }, (_, index) => index);
  const encoded = Buffer.from(bytes).toString('base64');
  const wrapped = encoded.match(/.{1,76}/g)!.join('\n') + '\n';
  mockGetImage.mockResolvedValue({data:`data:image/png;base64,${wrapped}`});
  mockWrite.mockResolvedValue(undefined);
  expect(await readSmartClipboard()).toMatchObject({image:{uri:'file:///cache/clipboard.png'}});
  expect(mockWrite).toHaveBeenCalledWith(bytes);
  mockGetImage.mockResolvedValue({data:'data:image/png;base64,AA=A'});
  await expect(readSmartClipboard()).rejects.toThrow('Invalid image data');
 } finally {
  globalThis.atob = originalAtob;
  globalThis.btoa = originalBtoa;
 }
});
