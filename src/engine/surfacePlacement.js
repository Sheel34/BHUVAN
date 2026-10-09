// Same A-B-D / D-B-C diagonal as the native terrain mesh. Bilinear heights
// generally lie above or below that mesh on a non-planar four-corner cell.
export function triangleHeight(h00, h10, h01, h11, x, z) {
  if (![h00,h10,h01,h11,x,z].every(Number.isFinite)) return NaN;
  return x + z <= 1 ? h00 * (1-x-z) + h10*x + h01*z
    : h11 * (x+z-1) + h10*(1-z) + h01*(1-x);
}

export const ROVER_WHEELS = Object.freeze([-1,1].flatMap(x=>[-.85,0,.85].map(z=>Object.freeze([x,z]))));

export function roverGroundSupport(position, heading, heightAt, wheels=ROVER_WHEELS) {
  const c=Math.cos(heading),s=Math.sin(heading);
  const contacts=wheels.map(([x,z])=> {
    const wx=position[0]+c*x+s*z,wz=position[2]-s*x+c*z;
    return {x,z,worldX:wx,worldZ:wz,height:heightAt(wx,wz)};
  });
  if(contacts.some(p=>!Number.isFinite(p.height)))throw new Error('Native ground under a rover wheel is unavailable. Move the rover away from the dataset edge.');
  const mean=contacts.reduce((sum,p)=>sum+p.height,0)/contacts.length;
  const across=contacts.reduce((sum,p)=>sum+p.x*(p.height-mean),0)/contacts.reduce((sum,p)=>sum+p.x*p.x,0);
  const along=contacts.reduce((sum,p)=>sum+p.z*(p.height-mean),0)/contacts.reduce((sum,p)=>sum+p.z*p.z,0);
  // Lift the fitted chassis plane until none of the sampled wheel contacts
  // penetrate the DEM. Residuals expose the approximation; no traction claim.
  const centerHeight=Math.max(...contacts.map(p=>p.height-across*p.x-along*p.z));
  return {centerHeight,pitch:Math.atan(along),roll:Math.atan(across),contacts,
    unsupportedHeight:Math.max(...contacts.map(p=>centerHeight+across*p.x+along*p.z-p.height))};
}
