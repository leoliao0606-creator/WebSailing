// 只报告浏览器实际提供的数据。帧率和 GPU 渲染毫秒都不等于操作系统的 GPU 占用率。
export class RenderStats {
  constructor(renderer) {
    const gl=renderer.getContext();this.gl=gl;
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    const name=String(gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER));
    this.device={name,kind:/swiftshader|llvmpipe|softpipe|software|warp/i.test(name)?'software':info?'hardware':'unknown'};
    this.extension=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending=[];this.active=null;this.gpuMs=null;
  }
  begin() {
    const {gl,extension:ext}=this;if(!ext || this.active || gl.isContextLost())return;
    const disjoint=gl.getParameter(ext.GPU_DISJOINT_EXT);
    if(disjoint){for(const q of this.pending)gl.deleteQuery(q);this.pending=[];this.gpuMs=null;return;}
    while(this.pending.length && gl.getQueryParameter(this.pending[0],gl.QUERY_RESULT_AVAILABLE)){
      const q=this.pending.shift();const ms=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;
      this.gpuMs=this.gpuMs===null?ms:this.gpuMs*0.8+ms*0.2;gl.deleteQuery(q);
    }
    if(this.pending.length>=4)return;
    this.active=gl.createQuery();
    if(this.active)gl.beginQuery(ext.TIME_ELAPSED_EXT,this.active);
  }
  end() {
    if(!this.active)return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);this.pending.push(this.active);this.active=null;
  }
  reset() {
    if(this.active){this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);this.gl.deleteQuery(this.active);}
    for(const q of this.pending)this.gl.deleteQuery(q);
    this.pending=[];this.active=null;this.gpuMs=null;
  }
}
