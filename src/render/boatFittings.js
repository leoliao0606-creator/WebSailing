import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 同材质五金件合并为一个网格，保留螺丝/滑轮/压舷带的轮廓而不堆积绘制调用。
export function addBoatFittings(group,boomGroup,radial=24){
  const root=new THREE.Group();root.name='deck-fittings';group.add(root);
  const metal=new THREE.MeshStandardMaterial({color:0xb6c3cb,metalness:0.88,roughness:0.25});
  const dark=new THREE.MeshStandardMaterial({color:0x25313c,metalness:0.15,roughness:0.5});
  const rubber=new THREE.MeshStandardMaterial({color:0x26313b,roughness:0.92});
  const ropeM=new THREE.MeshStandardMaterial({color:0xddddc5,roughness:0.85});
  const blue=new THREE.MeshStandardMaterial({color:0x246b91,roughness:0.78});
  const add=(parent,geo,mat,x,y,z)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);parent.add(m);return m;};
  const box=(parent,mat,x,y,z,w,h,d,r=0.01)=>add(parent,new RoundedBoxGeometry(w,h,d,2,r),mat,x,y,z);
  const tube=(parent,mat,points,radius=0.012)=>add(parent,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),Math.max(32,points.length*2),radius,8,false),mat,0,0,0);
  const bolt=(x,y,z)=>{
    add(root,new THREE.CylinderGeometry(0.018,0.018,0.01,6),metal,x,y,z);
    box(root,dark,x,y+0.006,z,0.02,0.002,0.004,0.001);
  };
  // 舱口包边，座舷防滑条，舱底压舷带和固定螺栓。
  tube(root,dark,[[-0.34,0.23,-0.25],[-0.4,0.25,0.02],[-0.4,0.25,1.25],[-0.29,0.24,1.57],
    [0.29,0.24,1.57],[0.4,0.25,1.25],[0.4,0.25,0.02],[0.34,0.23,-0.25],[-0.34,0.23,-0.25]],0.015);
  for(const side of [-1,1]){
    for(let i=0;i<5;i++)box(root,rubber,side*0.49,0.279,0.13+i*0.23,0.095,0.013,0.18,0.009);
    box(root,metal,side*0.11,0.105,0.08,0.065,0.024,0.09);
    box(root,metal,side*0.11,0.13,1.45,0.065,0.024,0.09);
    bolt(side*0.11,0.125,0.08);bolt(side*0.11,0.15,1.45);
  }
  // 宽带有拱起的截面，脚可以钩住。
  const strapGeo=new THREE.PlaneGeometry(0.17,1.34,4,24);strapGeo.rotateX(-Math.PI/2);
  const pos=strapGeo.attributes.position;
  for(let i=0;i<pos.count;i++)pos.setY(i,0.14+Math.sin((pos.getZ(i)/1.34+0.5)*Math.PI)*0.10);
  strapGeo.computeVertexNormals();const strap=add(root,strapGeo,rubber,0,0,0.77);strap.material= rubber;
  // 船艏检修口和桅杆座。
  add(root,new THREE.CylinderGeometry(0.15,0.16,0.026,radial),dark,0,0.314,-0.62);
  add(root,new THREE.CylinderGeometry(0.13,0.13,0.03,radial),metal,0,0.322,-0.62);
  box(root,dark,0,0.34,-0.62,0.13,0.012,0.027,0.005);
  add(root,new THREE.CylinderGeometry(0.11,0.14,0.085,radial),dark,0,0.36,-1.28);
  for(const y of [0.5,1.0,2.4])add(root,new THREE.CylinderGeometry(0.046,0.047,0.05,radial),metal,0,y,-1.28);
  // 导缆器和羊角系缆桩。
  for(const side of [-1,1]){
    const x=side*0.24,z=-0.83;
    box(root,metal,x,0.33,z,0.11,0.023,0.07);
    box(root,dark,x,0.365,z,0.045,0.055,0.045);
    const horn=add(root,new THREE.CylinderGeometry(0.014,0.018,0.13,radial),metal,x,0.39,z);horn.rotation.z=Math.PI/2;
    bolt(x,0.349,z-0.045);bolt(x,0.349,z+0.045);
  }
  tube(root,ropeM,[[-0.44,0.31,1.76],[-0.2,0.34,1.71],[0,0.32,1.69],[0.2,0.34,1.71],[0.44,0.31,1.76]],0.009);
  // 舱内绳圈与前甲板控制绳。
  const coil=[];
  for(let i=0;i<=140;i++){const t=i/140,angle=t*Math.PI*8;coil.push([0.23+Math.cos(angle)*(0.09+t*0.065),0.13+t*0.01,0.96+Math.sin(angle)*(0.15+t*0.03)]);}
  tube(root,blue,coil,0.009);
  tube(root,blue,[[0,0.5,-1.28],[0.11,0.34,-0.91],[0.2,0.3,-0.3],[0.22,0.14,0.25]],0.009);
  const pulley=(parent,x,y,z)=>{
    const disk=add(parent,new THREE.CylinderGeometry(0.055,0.055,0.026,radial),dark,x,y,z);disk.rotation.z=Math.PI/2;
    for(const s of [-1,1]){
      const plate=add(parent,new THREE.CylinderGeometry(0.067,0.067,0.008,radial),metal,x+s*0.019,y,z);plate.rotation.z=Math.PI/2;
    }
  };
  pulley(root,0,0.27,0.95);pulley(boomGroup,0,0.91,1.4);pulley(boomGroup,0,0.91,2.3);
  tube(boomGroup,ropeM,[[0,0.8,0.05],[0,0.85,0.4],[0,0.91,1.38]],0.008);
  // 合并静态部分，仅在建模时执行。
  const batches=new Map();
  root.updateMatrixWorld(true);
  for(const child of [...root.children]){
    if(!child.isMesh)continue;
    const list=batches.get(child.material)??[];
    const geo=child.geometry.index?child.geometry.toNonIndexed():child.geometry.clone();geo.applyMatrix4(child.matrix);list.push(geo);batches.set(child.material,list);
    child.geometry.dispose();root.remove(child);
  }
  for(const [material,geos] of batches){
    const merged=mergeGeometries(geos,false);for(const geo of geos)geo.dispose();
    const mesh=new THREE.Mesh(merged,material);mesh.castShadow=mesh.receiveShadow=true;root.add(mesh);
  }
  return root;
}

export function createMainsheet(){
  const rows=24,sides=6,geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array((rows+1)*sides*3),3).setUsage(THREE.DynamicDrawUsage));
  const idx=[];for(let r=0;r<rows;r++)for(let s=0;s<sides;s++){
    const a=r*sides+s,b=r*sides+(s+1)%sides;idx.push(a,b,a+sides,b,b+sides,a+sides);
  }
  geo.setIndex(idx);const mesh=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0xd7d4b9,roughness:0.9}));
  mesh.frustumCulled=false;
  const tangent=new THREE.Vector3(),normal=new THREE.Vector3(),binormal=new THREE.Vector3();
  const up=new THREE.Vector3(0,1,0);
  return {mesh,update(bx,by,bz){
    const mid=[bx*0.5,Math.max(0.19,by*0.43),(bz+0.9)*0.5];const pos=geo.attributes.position;
    for(let r=0;r<=rows;r++){
      const t=r/rows,s=1-t;
      const x=s*s*bx+2*s*t*mid[0],y=s*s*by+2*s*t*mid[1]+t*t*0.24,z=s*s*bz+2*s*t*mid[2]+t*t*0.9;
      tangent.set(2*s*(mid[0]-bx)-2*t*mid[0],2*s*(mid[1]-by)+2*t*(0.24-mid[1]),2*s*(mid[2]-bz)+2*t*(0.9-mid[2])).normalize();
      normal.crossVectors(tangent,up);if(normal.lengthSq()<0.001)normal.set(1,0,0);normal.normalize();binormal.crossVectors(tangent,normal);
      for(let j=0;j<sides;j++){const angle=j/sides*Math.PI*2,c=Math.cos(angle)*0.009,d=Math.sin(angle)*0.009;pos.setXYZ(r*sides+j,x+normal.x*c+binormal.x*d,y+normal.y*c+binormal.y*d,z+normal.z*c+binormal.z*d);}
    }
    pos.needsUpdate=true;geo.computeVertexNormals();
  }};
}
