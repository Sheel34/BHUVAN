// PNG iTXt: https://www.w3.org/TR/png-3/#11iTXt
// Keep image and coordinate context in one download; browsers may block a second.
export function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) {crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
export function embedCaptureMetadata(png,metadata) {
  const signature=[137,80,78,71,13,10,26,10];
  if(png.length<20||signature.some((v,i)=>png[i]!==v))throw new Error('Capture is not a valid PNG.');
  const encoder=new TextEncoder(),keyword=encoder.encode('BHUVAN.Metadata'),json=encoder.encode(JSON.stringify(metadata));
  const body=new Uint8Array(keyword.length+5+json.length);body.set(keyword);body.set(json,keyword.length+5);
  const chunk=new Uint8Array(body.length+12),view=new DataView(chunk.buffer);
  view.setUint32(0,body.length);chunk.set(encoder.encode('iTXt'),4);chunk.set(body,8);
  view.setUint32(body.length+8,crc32(chunk.subarray(4,body.length+8)));
  const sourceView=new DataView(png.buffer,png.byteOffset,png.byteLength);
  let position=8;
  while(position+12<=png.length) {
    const length=sourceView.getUint32(position);
    if(position+length+12>png.length)break;
    if(png[position+4]===73&&png[position+5]===69&&png[position+6]===78&&png[position+7]===68) {
      const result=new Uint8Array(png.length+chunk.length);result.set(png.subarray(0,position));result.set(chunk,position);result.set(png.subarray(position),position+chunk.length);return result;
    }
    position+=length+12;
  }
  throw new Error('Capture has no complete PNG trailer.');
}
