// 每船一个效果实例：贴浪的尾迹泡沫带、开尔文波系 V 臂、沿船体水线的破浪白花，
// 以及 GPU 实例化的飞沫与泡沫团。所有几何都跟着 Gerstner 浪面走，横跨波峰时不会沉没。
import * as THREE from 'three';
import { clamp01 } from '../util/math.js';
import { WAVE_COUNT, WAVE_STRIDE } from '../sim/waves.js';
import { createSeededRandom } from '../sim/random.js';
import { EFFECT_BUDGETS } from './quality.js';

// 与海面相同的 Gerstner 位移；泡沫的每个顶点都跟随浪面，避免横跨波峰时沉没。
const SURFACE = /* glsl */ `
uniform float uWaveTime;
uniform float uWaves[${WAVE_COUNT * WAVE_STRIDE}];
vec3 seaSurface(vec2 xz) {
  vec3 p = vec3(xz.x, 0.035, xz.y);
  for(int i=0; i<${WAVE_COUNT}; i++) {
    vec2 d = vec2(uWaves[i*7], uWaves[i*7+1]);
    float ph = uWaves[i*7+2] * dot(d,xz) - uWaves[i*7+3] * uWaveTime + uWaves[i*7+6];
    float h = uWaves[i*7+4] * cos(ph);
    p.y += h;
    p.xz += d * uWaves[i*7+5] * h;
  }
  return p;
}`;
const FOAM = /* glsl */ `
uniform vec3 uFoamColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
float foamNoise(vec2 p) {
  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float foamGrain(vec2 p) {
  vec2 cell=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(foamNoise(cell),foamNoise(cell+vec2(1,0)),f.x),
    mix(foamNoise(cell+vec2(0,1)),foamNoise(cell+vec2(1,1)),f.x),f.y);
}
// 三个倍频叠加：真实泡沫同时有大团、小块和细泡，单一频率看着像均匀噪点。
float foamFbm(vec2 p) {
  return foamGrain(p)*0.54 + foamGrain(p*2.17+19.3)*0.30 + foamGrain(p*4.93+7.1)*0.16;
}
vec3 foamColor(float dist, float grain) {
  float fog=1.0-exp(-uFogDensity*uFogDensity*dist*dist);
  return mix(uFoamColor*(0.82+grain*0.18),uFogColor,fog);
}`;

// 尾流的四条带子。kind 决定片元着色分支：
//  - 内核：船尾翻滚的白色泡沫，紧接船尾最浓
//  - 外晕：内核外侧零散的泡沫点，负责把内核的硬边化开
//  - V 臂：开尔文波系的发散波。深水里张开半角恒为 19.47°，tan ≈ 0.354，
//          与船速无关 —— 这是它一眼就能认出是「船开过」的原因。
// 几何按「离船尾多远（米）」展开而不是按「存在了多久」，船加减速时张角才不变：
//   半宽 = half0 + halfRate·√behind   湍流尾迹的横向扩散约正比于距离的平方根，
//                                     线性展开会让 30 m 外的尾迹宽得像跑道
//   中心 = spread·(behind + 2.4)      V 臂由船艏发出，过船尾时已在船宽之外
// 透明度则按存在时间衰减（decay），泡沫是随时间消散的。
const WAKE_BANDS = [
  { kind: 0, half0: 0.68, halfRate: 0.22, spread: 0, decay: 0.32, alpha: 0.92 },
  { kind: 1, half0: 1.00, halfRate: 0.40, spread: 0, decay: 0.22, alpha: 0.55 },
  { kind: 2, half0: 0.44, halfRate: 0.20, spread: 0.354, decay: 0.20, alpha: 0.46 },
  { kind: 2, half0: 0.44, halfRate: 0.20, spread: -0.354, decay: 0.20, alpha: 0.46 },
];
const WAKE_MAX_AGE = 13;   // 秒：泡沫痕迹的最长存活时间
const HULL_ROWS = 30, HULL_COLS = 4;

// 水线半宽沿船长的近似（t: 0=艏尖，1=艉）。ILCA 是宽尾船型，艉部不收到零。
function hullHalfBeam(t) {
  return 0.70 * Math.min(1, Math.pow(t * 3.1, 0.8)) * (1 - 0.18 * t * t);
}

function ribbonGeometry(rows, kinds, columns=6) {
  const bands=kinds.length, geo=new THREE.BufferGeometry(), stride=columns+1, count=rows*bands*stride;
  geo.userData.columns=columns;
  for(const [name,size] of [['position',3],['uv',2],['aAlpha',1],['aWidth',1]]) {
    geo.setAttribute(name,new THREE.BufferAttribute(new Float32Array(count*size),size).setUsage(THREE.DynamicDrawUsage));
  }
  // kind 逐带恒定，建好就不再改，不必每帧上传。
  const kind=new Float32Array(count);
  for(let b=0;b<bands;b++) kind.fill(kinds[b], b*rows*stride, (b+1)*rows*stride);
  geo.setAttribute('aKind',new THREE.BufferAttribute(kind,1));
  const idx=[];
  for(let b=0;b<bands;b++) for(let r=0;r<rows-1;r++) for(let c=0;c<columns;c++) {
    const a=(b*rows+r)*stride+c; idx.push(a,a+stride,a+1,a+1,a+stride,a+stride+1);
  }
  geo.setIndex(idx);
  return geo;
}

export class BoatEffects {
  constructor(scene,waveField) {
    this.scene=scene; this.waveField=waveField;
    this.enabled=true; this.time=0; this.spawnAcc=0;
    this.samples=[]; this.lastX=null; this.lastZ=null;
    this.travel=0; this.lastSampleAt=0; // 累计航距 m：尾流顶点靠它算「离船尾多远」
    this.foamFlow=0; // 船体白花的纹理滚动量 m，取模避免长时间累加丢精度
    this.random=createSeededRandom(82713); // 装饰随机数不消费物理/AI 的随机序列。
    this.uniforms={
      uTime:{value:0}, uWaveTime:{value:0},
      uWaves:{value:new Float32Array(WAVE_COUNT*WAVE_STRIDE)},
      uFoamColor:{value:new THREE.Color(1.15,1.2,1.24)},
      uFogColor:{value:new THREE.Color(0.6,0.75,0.82)}, uFogDensity:{value:0.00032},
    };
    this.wakeMat=new THREE.ShaderMaterial({
      name:'BoatFoam', uniforms:this.uniforms,
      vertexShader: `${SURFACE}
        attribute float aAlpha; attribute float aKind; attribute float aWidth;
        varying vec2 vUv; varying float vA; varying float vDist; varying float vKind; varying float vWidth;
        void main(){ vec3 p=seaSurface(position.xz); vUv=uv; vA=aAlpha; vKind=aKind; vWidth=aWidth;
          vDist=distance(cameraPosition,p); gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0); }`,
      fragmentShader: `${FOAM}
        varying vec2 vUv; varying float vA; varying float vDist; varying float vKind; varying float vWidth;
        void main(){
          float across=vUv.x*2.0-1.0;      // -1..1 横跨带宽，用来定形状
          float ax=across*vWidth;          // 同一点的横向米数，用来取噪声
          float along=vUv.y;               // 沿带方向的米数
          // 噪声坐标一律用米：带子越展越宽时，泡沫团的大小不跟着被拉长
          float grain, alpha;
          if(vKind<0.5){
            // 内核：翻滚的泡沫按团破碎，团之间露出水面
            grain=foamFbm(vec2(ax*0.55, along*0.72));
            float fine=foamGrain(vec2(ax*2.3, along*2.6));
            float body=1.0-smoothstep(0.22,1.0,abs(across));
            alpha=body*smoothstep(0.30,0.72,grain*0.70+fine*0.30)*vA;
          } else if(vKind<1.5){
            // 外晕：更宽更稀，只留零散泡沫点，负责化开内核的硬边
            grain=foamFbm(vec2(ax*0.34, along*0.44));
            float halo=1.0-smoothstep(0.0,1.0,abs(across));
            alpha=halo*smoothstep(0.54,0.95,grain)*vA*0.75;
          } else {
            // V 臂：开尔文波系的发散波。波脊并不横跨臂宽，而是与航向约成 35° 斜着排，
            // 所以相位要同时吃 along 和横向米数 —— 只用 along 的话会被裁成一列横杠。
            grain=foamGrain(vec2(ax*0.9, along*1.7));
            // 波长约 1.0 m，再用噪声扰相位。等周期的纯正弦在俯视下会读成一排梯格。
            float phase=(along*0.82+ax*0.57)*6.2+grain*1.7;
            float ridge=0.5+0.5*sin(phase);
            float core=exp(-across*across*2.6);
            // 基线 0.20 保证臂上始终有一道连续的淡痕，脊只是叠在它上面的起伏；
            // 谷部压到全黑就成了断续的线段。
            alpha=core*(0.20+pow(ridge,1.8)*0.60)*vA;
          }
          if(alpha<0.012) discard;
          gl_FragColor=vec4(foamColor(vDist,grain),min(alpha,0.82));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent:true, depthWrite:false, side:THREE.DoubleSide,
    });
    this.sprayMat=new THREE.ShaderMaterial({
      name:'BoatSpray', uniforms:this.uniforms,
      vertexShader: `${SURFACE}
        uniform float uTime;
        attribute vec3 aOrigin; attribute vec3 aVelocity;
        attribute vec2 aSize; attribute float aBirth; attribute float aLife; attribute float aKind;
        varying vec2 vUv; varying float vA; varying float vKind; varying float vDist; varying float vSeed;
        void main(){
          float age=max(0.0,uTime-aBirth), life=clamp(age/max(aLife,0.001),0.0,1.0);
          vKind=aKind; vUv=uv;
          vSeed=fract(aBirth*0.137+dot(aOrigin.xz,vec2(0.173,0.197)));
          vA=step(aBirth,uTime)*(1.0-step(aLife,age))*smoothstep(0.0,0.06,age)*(1.0-life);
          vec4 mv;
          if(aKind>0.5){
            // 水面泡沫团：躺在浪面上摊开并逐渐变大
            vec3 center=aOrigin+aVelocity*age;
            float growth=1.0+life*1.5;
            center=seaSurface(center.xz+position.xy*aSize*growth);
            mv=viewMatrix*vec4(center,1.0);
            vDist=distance(cameraPosition,center);
          }else{
            // 飞沫：空气阻力让水滴很快减速，位移是 v0/k·(1-e^-kt) 而不是匀速直线；
            // 竖直方向再叠自由落体。
            float k=1.2;
            vec3 center=aOrigin+aVelocity*((1.0-exp(-k*age))/k);
            center.y-=4.9*age*age;
            mv=viewMatrix*vec4(center,1.0);
            // 每颗水滴各自转一个角度，否则整片飞沫是清一色同方向的竖椭圆
            float rot=vSeed*6.2831;
            vec2 q=vec2(position.x*cos(rot)-position.y*sin(rot),
                        position.x*sin(rot)+position.y*cos(rot));
            mv.xy+=q*aSize*(1.0+life*0.5);
            vDist=distance(cameraPosition,center);
          }
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: `${FOAM}
        varying vec2 vUv; varying float vA; varying float vKind; varying float vDist; varying float vSeed;
        void main(){
          vec2 p=(vUv-0.5)*2.0;
          float radius=dot(p,p);
          float grain, alpha;
          if(vKind>0.5){
            // 泡沫团：两个频率的噪声从边缘啃出缺口。只用低频的话边界仍然接近圆
            float shape=foamFbm(p*2.6+vSeed*23.0)*0.7+foamGrain(p*6.5+vSeed*41.0)*0.3;
            float edge=1.0-smoothstep(0.05,0.98,radius+shape*0.95-0.38);
            grain=foamGrain(vUv*9.0+vSeed*31.7);
            alpha=edge*smoothstep(0.26,0.80,grain)*vA*0.85;
          }else{
            // 水珠：单颗画实就成了玻璃珠。边缘用高斯化开、压低不透明度，
            // 一片飞沫的存在感靠数量堆出来，不靠单颗的轮廓。
            grain=foamGrain(vUv*6.0+vSeed*13.0);
            alpha=exp(-radius*2.6)*vA*(0.30+grain*0.40);
          }
          if(alpha<0.015) discard;
          gl_FragColor=vec4(foamColor(vDist,grain),min(alpha,0.95));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent:true,depthWrite:false,side:THREE.DoubleSide,
    });
    this.wakeMesh=new THREE.Mesh(new THREE.BufferGeometry(),this.wakeMat);
    this.bowMesh=new THREE.Mesh(ribbonGeometry(HULL_ROWS,[0,0],HULL_COLS),this.wakeMat);
    this.sprayPoints=new THREE.Mesh(new THREE.InstancedBufferGeometry(),this.sprayMat);
    for(const mesh of [this.wakeMesh,this.bowMesh,this.sprayPoints]) {
      mesh.frustumCulled=false; mesh.renderOrder=4;
      mesh.onBeforeRender=(_renderer,s)=>{
        if(s.fog){this.uniforms.uFogColor.value.copy(s.fog.color);this.uniforms.uFogDensity.value=s.fog.density;}
        const sun=s.children.find(o=>o.isDirectionalLight);
        if(sun) this.uniforms.uFoamColor.value.copy(sun.color).multiplyScalar(0.65+sun.intensity*0.18);
      };
      scene.add(mesh);
    }
    this.setDetail('high');
  }

  setDetail(level) {
    level=Object.hasOwn(EFFECT_BUDGETS,level)?level:'high';
    if(this.detail===level) return;
    this.detail=level; this.budget=EFFECT_BUDGETS[level]; this.PN=this.budget.particles;
    this.wakeMesh.geometry.dispose();
    this.wakeGeo=this.wakeMesh.geometry=ribbonGeometry(this.budget.wake,WAKE_BANDS.map(b=>b.kind));
    this.sprayPoints.geometry.dispose();
    const base=new THREE.PlaneGeometry(1,1), geo=new THREE.InstancedBufferGeometry();
    geo.index=base.index; geo.attributes.position=base.attributes.position; geo.attributes.uv=base.attributes.uv;
    base.dispose();
    for(const [name,size] of [['aOrigin',3],['aVelocity',3],['aSize',2],['aBirth',1],['aLife',1],['aKind',1]]) {
      geo.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(this.PN*size),size).setUsage(THREE.DynamicDrawUsage));
    }
    geo.instanceCount=this.PN;
    this.sprayGeo=this.sprayPoints.geometry=geo;
    this.parts=Array.from({length:this.PN},()=>({life:0,max:0}));
    this.reset();
  }

  reset() {
    this.samples.length=0; this.spawnAcc=0; this.lastX=this.lastZ=null; this.travel=this.lastSampleAt=0;
    for(const p of this.parts) p.life=0;
    this._freeParts=this.parts.map((_,i)=>i);
    this.sprayGeo.attributes.aLife.array.fill(0);
    this.sprayGeo.attributes.aLife.needsUpdate=true;
    this.wakeGeo.attributes.aAlpha.array.fill(0);
    this.wakeGeo.attributes.aAlpha.needsUpdate=true;
    this.bowMesh.geometry.attributes.aAlpha.array.fill(0);
    this.bowMesh.geometry.attributes.aAlpha.needsUpdate=true;
  }

  setEnabled(on) {
    on=Boolean(on); if(this.enabled===on)return;
    this.enabled=on;
    for(const mesh of [this.wakeMesh,this.bowMesh,this.sprayPoints]) mesh.visible=on;
    this.reset();
  }

  get activeParticles(){return this.PN-this._freeParts.length;}

  update(phys,dt) {
    if(!this.enabled || dt<=0)return;
    dt=Math.min(dt,0.1); this.time+=dt;
    this.uniforms.uTime.value=this.time;this.uniforms.uWaveTime.value=this.waveField.time;
    this.waveField.packUniforms(this.uniforms.uWaves.value);
    let moved=this.lastX===null?0:Math.hypot(phys.x-this.lastX,phys.z-this.lastZ);
    if(moved>20){this.reset();moved=0;}
    if(this.lastX===null){this.lastX=phys.x;this.lastZ=phys.z;}
    const spd=phys.capsized?0:Math.max(0,phys.u??phys.speed);
    const strength=clamp01((spd-0.25)/2.2), plane=phys.out.planing??0;
    const fx=Math.sin(phys.psi),fz=-Math.cos(phys.psi),rx=Math.cos(phys.psi),rz=Math.sin(phys.psi);
    this.foamFlow=(this.foamFlow+spd*dt)%256;
    for(const s of this.samples)s.age+=dt;
    this.samples=this.samples.filter(s=>s.age<WAKE_MAX_AGE);
    this.travel+=moved;
    this.lastX=phys.x;this.lastZ=phys.z;
    // 采样间距随船速放宽：低速时尾迹短、要密；高速时同样的点数要铺得更远。
    const step=Math.max(0.24,spd*0.13);
    if(this.travel-this.lastSampleAt>step && spd>0.3){
      this.lastSampleAt=this.travel;
      this.samples.unshift({x:phys.x-fx*2.05,z:phys.z-fz*2.05,rx,rz,age:0,str:strength,travel:this.travel});
      if(this.samples.length>=this.budget.wake)this.samples.pop();
    }
    // 第 0 行固定画在当前船尾，否则尾迹起点会随采样间距在船后一跳一跳地离开
    const head=this.samples.length?{x:phys.x-fx*2.05,z:phys.z-fz*2.05,rx,rz,age:0,str:strength,travel:this.travel}:null;
    // —— 尾流带 ——
    const rows=this.budget.wake, wg=this.wakeGeo;
    const columns=wg.userData.columns, stride=columns+1;
    const wpos=wg.attributes.position.array, wuv=wg.attributes.uv.array;
    const walpha=wg.attributes.aAlpha.array, wwidth=wg.attributes.aWidth.array;
    for(let band=0;band<WAKE_BANDS.length;band++){
      const B=WAKE_BANDS[band];
      for(let i=0;i<rows;i++){
        const s=i?this.samples[i-1]:head, base=(band*rows+i)*stride;
        if(!s){for(let c=0;c<=columns;c++)walpha[base+c]=0;continue;}
        const behind=this.travel-s.travel;              // 该点离船尾多远（米）
        const half=B.half0+Math.sqrt(behind)*B.halfRate;
        const center=B.spread*(behind+2.4);             // V 臂由船艏发出，过船尾时已在船宽之外
        const a=Math.exp(-s.age*B.decay)*(1-s.age/WAKE_MAX_AGE)*s.str*B.alpha;
        for(let c=0;c<=columns;c++){
          const f=c/columns, offset=center+(f*2-1)*half, k=base+c;
          wpos[k*3]=s.x+s.rx*offset; wpos[k*3+1]=0; wpos[k*3+2]=s.z+s.rz*offset;
          wuv[k*2]=f; wuv[k*2+1]=behind;
          walpha[k]=a; wwidth[k]=half;
        }
      }
    }
    for(const name of ['position','uv','aAlpha','aWidth']) wg.attributes[name].needsUpdate=true;
    // —— 船体水线的破浪白花 ——
    const hg=this.bowMesh.geometry, hstride=HULL_COLS+1;
    const hpos=hg.attributes.position.array, huv=hg.attributes.uv.array;
    const halpha=hg.attributes.aAlpha.array, hwidth=hg.attributes.aWidth.array;
    // 低速也要有水线白边：破水是接触水面就发生的，不像尾迹那样要靠速度堆出来
    const hullStr=clamp01((spd-0.12)/1.1);
    for(let side=0;side<2;side++)for(let i=0;i<HULL_ROWS;i++){
      const t=i/(HULL_ROWS-1), along=2.02-t*4.18;
      const beam=hullHalfBeam(t);
      const bow=Math.exp(-(((t-0.15)/0.30)**2));         // 艏部破水峰：白花最浓的地方
      const width=(0.09+strength*0.42)*(0.34+bow);
      const base=(side*HULL_ROWS+i)*hstride;
      const a=hullStr*(0.40+bow*1.05)*(1-t*0.18)*(0.85+plane*0.35);
      for(let c=0;c<=HULL_COLS;c++){
        const f=c/HULL_COLS, across=(side?1:-1)*(beam+0.012+f*width), k=base+c;
        hpos[k*3]=phys.x+fx*along+rx*across; hpos[k*3+1]=0; hpos[k*3+2]=phys.z+fz*along+rz*across;
        // 噪声坐标叠上航距，泡沫看起来沿船体往后流，而不是钉在船上
        huv[k*2]=f; huv[k*2+1]=t*4.18+this.foamFlow;
        halpha[k]=a; hwidth[k]=width;
      }
    }
    for(const name of ['position','uv','aAlpha','aWidth']) hg.attributes[name].needsUpdate=true;
    // —— 飞沫与泡沫团 ——
    for(let i=0;i<this.PN;i++){
      const p=this.parts[i];if(p.life<=0)continue;
      p.life=Math.max(0,p.life-dt);if(p.life===0)this._freeParts.push(i);
    }
    const slam=phys.capsized?0:Math.min(phys.wave?.slamSpeed??0,3);
    const rate=(Math.max(0,spd-0.4)*(150+plane*130)+Math.max(0,slam-0.4)*220)*this.budget.rate;
    this.spawnAcc=Math.min(this.spawnAcc+rate*dt,this.PN);
    let spawned=0;
    while(this.spawnAcc>=1 && this._freeParts.length){
      this.spawnAcc--;spawned++;
      const index=this._freeParts.pop(),random=this.random;
      const side=random()<0.5?-1:1, roll=random();
      let kind,along,across;
      if(roll<0.44){          // 艏部破水：向外上方飞的水珠，最密的一处
        kind=0; along=1.24+random()*0.86; across=side*(0.14+random()*0.32);
      }else if(roll<0.68){    // 沿船体水线：贴着船帮的小泡沫
        kind=1; along=-0.9+random()*2.4; across=side*(0.44+random()*0.26);
      }else{                  // 船尾湍流：大片泡沫团，偶尔崩出水珠
        kind=random()<0.78?1:0; along=-2.5-random()*1.7; across=side*random()*0.72;
      }
      const x=phys.x+fx*along+rx*across,z=phys.z+fz*along+rz*across;
      const y=this.waveField.sample(x,z).y+0.055;
      // 泡沫团只在尾迹里随水打转，横向踢力要小；飞沫才是被撞出去的
      const kick=(0.30+random()*1.0)*(0.55+spd*0.22)*(kind?0.16:1);
      const life=kind?1.0+random()*1.6:0.35+random()*0.5;
      const p=this.parts[index];p.life=p.max=life;
      const attr=this.sprayGeo.attributes;
      attr.aOrigin.setXYZ(index,x,y,z);
      attr.aVelocity.setXYZ(index,fx*spd*(kind?0.10:0.42)+rx*side*kick,
        kind?0:0.9+random()*1.5+plane*1.0+slam*0.5,fz*spd*(kind?0.10:0.42)+rz*side*kick);
      const size=kind?0.07+random()*0.20:0.016+random()*0.040;
      attr.aSize.setXY(index,size,kind?size:size*(1.5+random()));
      attr.aBirth.setX(index,this.time);attr.aLife.setX(index,life);attr.aKind.setX(index,kind);
    }
    if(spawned)for(const [name,attr] of Object.entries(this.sprayGeo.attributes))if(name.startsWith('a'))attr.needsUpdate=true;
  }

  dispose(){
    for(const mesh of [this.wakeMesh,this.bowMesh,this.sprayPoints]){this.scene.remove(mesh);mesh.geometry.dispose();}
    this.wakeMat.dispose();this.sprayMat.dispose();
  }
}
