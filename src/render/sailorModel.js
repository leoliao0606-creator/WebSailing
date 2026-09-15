// 有服装结构、面部与末端肢体的水手；所有姿势仍由原航行状态驱动。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { surfaceTexture } from './surfaceTextures.js';

const UP=new THREE.Vector3(0,1,0);
export function createSailor(radial=24) {
  const crew=new THREE.Group();crew.name='sailor';
  const torso=new THREE.Group();torso.position.y=0.08;crew.add(torso);
  const fabric=surfaceTexture('sail');
  const suit=new THREE.MeshStandardMaterial({color:0x172737,roughness:0.86,bumpMap:fabric,bumpScale:0.0015});
  const panel=new THREE.MeshStandardMaterial({color:0x334958,roughness:0.8});
  const vest=new THREE.MeshPhysicalMaterial({color:0xe55a27,roughness:0.76,sheen:0.2,sheenColor:0xffbb69,bumpMap:fabric,bumpScale:0.0018});
  const strap=new THREE.MeshStandardMaterial({color:0x17202a,roughness:0.95});
  const skin=new THREE.MeshStandardMaterial({color:0xc99270,roughness:0.68});
  const trim=new THREE.MeshStandardMaterial({color:0xc8d7db,roughness:0.55});
  const capM=new THREE.MeshStandardMaterial({color:0xe7dfc8,roughness:0.84,bumpMap:fabric,bumpScale:0.001});
  const lens=new THREE.MeshPhysicalMaterial({color:0x12384a,metalness:0.45,roughness:0.14,clearcoat:1});
  const dark=new THREE.MeshStandardMaterial({color:0x382728,roughness:0.8});
  const fine=radial>=16;
  const add=(parent,geo,mat,pos,scale=null)=>{
    const mesh=new THREE.Mesh(geo,mat);mesh.position.set(...pos);if(scale)mesh.scale.set(...scale);parent.add(mesh);return mesh;
  };
  const sphere=(parent,mat,pos,scale)=>add(parent,new THREE.SphereGeometry(1,radial,Math.max(8,radial>>1)),mat,pos,scale);
  const box=(parent,mat,pos,size,radius=0.015)=>add(parent,new RoundedBoxGeometry(...size,radial>=24?3:2,radius),mat,pos);
  const tube=(parent,mat,points,radius=0.008)=>{
    const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));
    return add(parent,new THREE.TubeGeometry(curve,12,radius,6,false),mat,[0,0,0]);
  };
  // 定制胸腹轮廓：横向为肩宽，前后为胸厚，避免胶囊躯干的上下等宽。
  const rows=[[0.0,0.115,0.15],[0.08,0.14,0.16],[0.22,0.15,0.18],[0.4,0.155,0.23],[0.5,0.13,0.235],[0.57,0.07,0.13]];
  const positions=[],indices=[],uvs=[];
  for(const [y,depth,width] of rows)for(let i=0;i<=radial;i++){
    const a=i/radial*Math.PI*2;positions.push(Math.cos(a)*depth,y,Math.sin(a)*width);uvs.push(i/radial,y*2);
  }
  for(let r=0;r<rows.length-1;r++)for(let i=0;i<radial;i++){
    const a=r*(radial+1)+i,b=a+radial+1;indices.push(a,b,a+1,b,b+1,a+1);
  }
  for(const end of [0,rows.length-1]){
    const center=positions.length/3;positions.push(0,rows[end][0],0);uvs.push(0.5,0.5);
    for(let i=0;i<radial;i++){
      const a=end*(radial+1)+i;
      if(end===0)indices.push(center,a,a+1);else indices.push(center,a+1,a);
    }
  }
  const body=new THREE.BufferGeometry();body.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));body.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));body.setIndex(indices);body.computeVertexNormals();
  add(torso,body,suit,[0,0,0]);
  sphere(crew,suit,[0,0.04,0],[0.14,0.115,0.17]);
  // 分片救生衣，黑色前拉链、腰带、肩带、反光条和口袋。
  for(const side of [-1,1]){
    box(torso,vest,[0.135,0.32,side*0.106],[0.11,0.37,0.185],0.035);
    box(torso,vest,[-0.125,0.32,side*0.105],[0.08,0.4,0.185],0.03);
    if(fine){
      box(torso,trim,[0.195,0.43,side*0.112],[0.008,0.037,0.11],0.003);
      box(torso,vest,[0.198,0.23,side*0.108],[0.032,0.115,0.13],0.018);
      tube(torso,strap,[[0.14,0.46,side*0.17],[0.1,0.58,side*0.18],[-0.06,0.59,side*0.17],[-0.14,0.47,side*0.16]],0.021);
    }
  }
  box(torso,strap,[0.195,0.33,0],[0.018,0.35,0.025],0.003);
  box(torso,trim,[0.208,0.38,0],[0.013,0.024,0.017],0.003);
  box(torso,strap,[0.193,0.115,0],[0.025,0.046,0.31],0.006);
  box(torso,trim,[0.214,0.115,0.014],[0.02,0.05,0.055],0.006);
  // 颈部和椭圆头部朝船员局部 +x；有下颌、鼻梁、耳朵和眼镜。
  add(torso,new THREE.CylinderGeometry(0.056,0.069,0.14,radial),skin,[0,0.6,0]);
  const head=new THREE.Group();head.position.set(0.006,0.75,0);torso.add(head);
  sphere(head,skin,[0,0,0],[0.103,0.136,0.103]);
  sphere(head,skin,[0.025,-0.07,0],[0.085,0.076,0.087]);
  for(const side of [-1,1]){
    sphere(head,skin,[-0.006,-0.003,side*0.103],[0.024,0.041,0.019]);
    if(fine){
      box(head,strap,[0.095,0.021,side*0.047],[0.035,0.05,0.087],0.013);
      box(head,lens,[0.115,0.022,side*0.047],[0.008,0.035,0.066],0.01);
      tube(head,strap,[[0.098,0.025,side*0.084],[0.02,0.02,side*0.111],[-0.048,0.008,side*0.101]],0.006);
    }
  }
  sphere(head,skin,[0.106,-0.017,0],[0.037,0.036,0.027]);
  if(fine){tube(head,dark,[[0.097,-0.072,-0.034],[0.107,-0.076,0],[0.097,-0.072,0.034]],0.003);}
  add(head,new THREE.SphereGeometry(0.111,radial,Math.max(8,radial>>1),0,Math.PI*2,0,1.4),capM,[0,0.027,0],[1,1.12,1]);
  const brim=sphere(head,capM,[0.112,0.053,0],[0.125,0.012,0.105]);brim.rotation.z=-0.1;
  if(fine)tube(head,trim,[[0.1,0.061,-0.087],[0.16,0.042,-0.067],[0.22,0.033,0],[0.16,0.042,0.067],[0.1,0.061,0.087]],0.003);

  const dir=new THREE.Vector3();
  function makeLimb(radius,span,material=suit){
    const mesh=add(crew,new THREE.CapsuleGeometry(radius,span,Math.max(5,radial>>2),radial),material,[0,0,0]);
    return {mesh,total:span+radius*2};
  }
  function placeLimb(limb,ax,ay,az,bx,by,bz){
    dir.set(bx-ax,by-ay,bz-az);const len=Math.max(dir.length(),1e-4);
    limb.mesh.position.set((ax+bx)/2,(ay+by)/2,(az+bz)/2);
    limb.mesh.quaternion.setFromUnitVectors(UP,dir.divideScalar(len));limb.mesh.scale.set(1,len/limb.total,1);
  }
  const limbs={thighL:makeLimb(0.087,0.25),thighR:makeLimb(0.087,0.25),
    shinL:makeLimb(0.06,0.26),shinR:makeLimb(0.06,0.26),
    armAftU:makeLimb(0.055,0.19),armFwdU:makeLimb(0.055,0.19),
    armAftF:makeLimb(0.042,0.22),armFwdF:makeLimb(0.042,0.22)};
  for(const limb of [limbs.shinL,limbs.shinR])box(limb.mesh,panel,[0.045,0.045,0],[0.04,0.17,0.085],0.016);
  const hands=[];
  for(let i=0;i<2;i++){
    const hand=new THREE.Group();crew.add(hand);hands.push(hand);
    sphere(hand,suit,[0,0.016,0],[0.041,0.06,0.026]);
    if(fine)for(let f=0;f<4;f++){
      const finger=add(hand,new THREE.CapsuleGeometry(0.009,0.028,4,8),skin,[(f-1.5)*0.016,0.066,0.012]);finger.rotation.x=0.7;
    }
    sphere(hand,skin,[0.035,0.03,0.012],[0.014,0.029,0.012]);
  }
  const boots=[];
  for(let i=0;i<2;i++){
    const boot=new THREE.Group();crew.add(boot);boots.push(boot);
    box(boot,strap,[0.052,0,0],[0.23,0.095,0.11],0.033);
    box(boot,panel,[0.052,-0.046,0],[0.23,0.018,0.114],0.008);
    if(fine)for(let y=0;y<3;y++)box(boot,trim,[0.065+y*0.029,0.047,0],[0.009,0.008,0.064],0.002);
  }
  function placeHand(index,ax,ay,az,bx,by,bz){
    const hand=hands[index];hand.position.set(bx,by,bz);
    dir.set(bx-ax,by-ay,bz-az).normalize();hand.quaternion.setFromUnitVectors(UP,dir);
  }
  function placeBoot(index,x,y,z,side){boots[index].position.set(x,y,z);boots[index].rotation.y=side<0?Math.PI:0;}
  crew.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
  return {crew,torso,head,limbs,placeLimb,placeHand,placeBoot};
}
