import * as THREE from 'three';
import { Game, FACES, SIZE, worldPoint, tileKey, neighbor, BOMB_STEP_SECONDS, FACE_COLLAPSE_WARNING, movementProgress, bombExplosionCell } from './engine.js';
import { GameAudio } from './audio.js';
import { CHARACTERS, getCharacterOrder } from './characters.js';
import { CubeClient, CUBE_SERVER_URL, applySnapshot } from './network.js';
import { TouchInputState } from './touch-input.js';

const $ = id => document.getElementById(id);
let selectedCharacter=0;
try {selectedCharacter=getCharacterOrder(Number(localStorage.getItem('cube-bomber-character')))[0];}catch{}
let characterOrder=getCharacterOrder(selectedCharacter);
const COLORS=characterOrder.map(id=>CHARACTERS[id].color);
const FACE_COLORS = [0x3bd8e5, 0xec60c6, 0x9782ff, 0x52e1b8, 0xffaf50, 0x659dff];
const vector = a => new THREE.Vector3(...a);
const clamp = THREE.MathUtils.clamp;
const smooth = x => x * x * (3 - 2 * x);
const game = new Game();
let playerId=0,onlineActive=false,onlineClient=null,onlineRoom=null,memberId=null,networkRound=-1,networkTick=-1,lastEventId=0;
let snapshotTime=0,snapshotReceivedAt=0,lastInputAt=-Infinity,lastInputDir=null,onlineResultShown=false,connectionState='offline';
const localPlayer=()=>game.players[playerId];
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let mode = 'intro', helpReturn = 'intro', pauseReturn = 'playing', viewTurn = 0, elapsed = 0, lastHud = 0, cameraTween = 1;
let soundEnabled = true, flashTime = 0, nextVoice = 7, countdownRemaining = 0, lastCountdownNumber = 0, lastCollapseBeat = null;
try { soundEnabled = localStorage.getItem('cube-bomber-sound') !== 'off'; } catch {}
const audio = new GameAudio();audio.setEnabled(soundEnabled);
const keys = new Set();
const touchInput=new TouchInputState();
let lastBombInputAt=-Infinity;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-12, 12, 10, -10, .1, 150);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({canvas: $('world'), antialias: true, alpha: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x060b16, 0);
} catch (err) {
  $('error-panel').classList.remove('hidden');
  $('error-message').textContent = 'Браузер не смог включить 3D. Включите аппаратное ускорение или откройте игру в другом браузере.';
  throw err;
}
scene.add(new THREE.AmbientLight(0x92b5e9, 1.4));
const sun = new THREE.DirectionalLight(0xe1faff, 2.5); sun.position.set(8, 15, 10); scene.add(sun);
const rim = new THREE.DirectionalLight(0xff51c4, 2.4); rim.position.set(-10, 2, -8); scene.add(rim);
const fill = new THREE.DirectionalLight(0x3efbec, 2); fill.position.set(2, -12, 7); scene.add(fill);

const cube = new THREE.Group(); scene.add(cube);
const faceGroups = FACES.map(face => {
  const group = new THREE.Group();
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(vector(face.u), vector(face.n), vector(face.v)));
  group.position.copy(vector(face.n).multiplyScalar(4));
  cube.add(group); return group;
});
const geometry = {
  tile: new THREE.BoxGeometry(.96, .065, .96),
  wall: new THREE.BoxGeometry(.88, .73, .88),
  brick: new THREE.BoxGeometry(.86, .54, .86),
  sphere: new THREE.SphereGeometry(1, 16, 12),
  box: new THREE.BoxGeometry(1, 1, 1),
  ring: new THREE.TorusGeometry(.36, .018, 5, 32),
  decal: new THREE.PlaneGeometry(.84, .84),
};
const mat = (color, metalness = .15, roughness = .65, emissive = 0, intensity = 0) => new THREE.MeshStandardMaterial({color, metalness, roughness, emissive, emissiveIntensity: intensity});
const neon = color => new THREE.MeshBasicMaterial({color, toneMapped: false});
const wallMat = mat(0x273d54, .72, .34), brickMat = mat(0xbc502c, .16, .6, 0x4e1002, .35);
const wallTop=mat(0x45617a,.8,.26), brickTop=mat(0xf08743,.18,.55);
const brickTrims=[neon(0xffdb68),neon(0xffd780)];
const faceTrim = FACE_COLORS.map(neon);
const dark = mat(0x101829, .3, .45), skin = mat(0xffdeb6, .02, .8), black = mat(0x161528, .2, .3);
function mesh(geo, material, parent, position, scale) {
  const m = new THREE.Mesh(geo, material);
  if(position) m.position.set(...position);
  if(scale) m.scale.set(...scale);
  parent.add(m); return m;
}
function box(parent, material, position, scale) { return mesh(geometry.box, material, parent, position, scale); }
function sphere(parent, material, position, scale) { return mesh(geometry.sphere, material, parent, position, scale); }
const matrix = new THREE.Matrix4();
const floorPlateMaterial=mat(0x121d32,.7,.35),floorTileMaterial=mat(0xffffff,.55,.48),floorDebrisMaterial=mat(0x24364d,.55,.48);
const floorRingGeometry=new THREE.RingGeometry(.29,.31,32);
const fullFaceBounds={minX:0,maxX:SIZE-1,minY:0,maxY:SIZE-1};
const boundsFor=face=>game.faceBounds?.[face]||fullFaceBounds;
const withinFaceBounds=(x,y,b)=>x>=b.minX&&x<=b.maxX&&y>=b.minY&&y<=b.maxY;
const faceSurfaces=faceGroups.map((group,f)=>{
  const plate=box(group,floorPlateMaterial,[0,-.15,0],[8.03,.3,8.03]);
  const tiles=new THREE.InstancedMesh(geometry.tile,floorTileMaterial,64);group.add(tiles);
  const gridMaterial=mat(FACE_COLORS[f],.5,.4,FACE_COLORS[f],.3);
  const lines=Array.from({length:9},()=>[
    box(group,gridMaterial,[0,.052,0],[.018,.012,8]),
    box(group,gridMaterial,[0,.052,0],[8,.012,.018])
  ]);
  const rims=Array.from({length:4},(_,dir)=>Array.from({length:8},()=>{
    const rim=box(group,faceTrim[f],[0,.058,0],[.018,.023,.46]);
    if(dir%2===0)rim.rotation.y=Math.PI/2;
    return rim;
  }));
  const rings=[[3,3],[3,4],[4,3],[4,4]].map(([x,y])=>{
    const ring=mesh(floorRingGeometry,faceTrim[f],group,[x-3.5,.058,y-3.5]);ring.rotation.x=-Math.PI/2;return {x,y,ring};
  });
  return {plate,tiles,lines,rims,rings,key:''};
});
function syncFaceSurfaces(){
  for(let f=0;f<6;f++){
    const surface=faceSurfaces[f],b=boundsFor(f),key=`${b.minX}:${b.maxX}:${b.minY}:${b.maxY}`;
    if(surface.key===key)continue;surface.key=key;
    const width=b.maxX-b.minX+1,height=b.maxY-b.minY+1,cx=(b.minX+b.maxX)/2-3.5,cy=(b.minY+b.maxY)/2-3.5;
    surface.plate.position.set(cx,-.15,cy);surface.plate.scale.set(width+.025,.3,height+.025);
    let index=0;
    for(let y=b.minY;y<=b.maxY;y++)for(let x=b.minX;x<=b.maxX;x++){
      matrix.makeTranslation(x-3.5,.017,y-3.5);surface.tiles.setMatrixAt(index,matrix);
      surface.tiles.setColorAt(index++,new THREE.Color((x+y)%2?0x24364d:0x1b2a40));
    }
    surface.tiles.count=index;surface.tiles.instanceMatrix.needsUpdate=true;surface.tiles.instanceColor.needsUpdate=true;surface.tiles.computeBoundingSphere();
    surface.lines.forEach(([vertical,horizontal],i)=>{
      vertical.visible=i>=b.minX&&i<=b.maxX+1;vertical.position.set(i-4,.052,cy);vertical.scale.set(.018,.012,height);
      horizontal.visible=i>=b.minY&&i<=b.maxY+1;horizontal.position.set(cx,.052,i-4);horizontal.scale.set(width,.012,.018);
    });
    surface.rims.forEach((rims,dir)=>rims.forEach((rim,i)=>{
      rim.visible=dir%2?i>=b.minY&&i<=b.maxY:i>=b.minX&&i<=b.maxX;
      if(dir%2)rim.position.set(dir===1?b.maxX-3-.015:b.minX-4+.015,.058,i-3.5);
      else rim.position.set(i-3.5,.058,dir===2?b.maxY-3-.015:b.minY-4+.015);
    }));
    for(const {x,y,ring} of surface.rings)ring.visible=withinFaceBounds(x,y,b);
  }
}
syncFaceSurfaces();

const blocks = new Map(), bombMeshes = new Map(), bonusMeshes = new Map();
const blockBatches=faceGroups.map(face=>{const group=new THREE.Group();face.add(group);return group;});
const fallingTiles=new Map(),seenShrinkStages=new Set();
function resetFaceDebris(){
  for(const drop of fallingTiles.values())drop.group.removeFromParent();
  fallingTiles.clear();seenShrinkStages.clear();
}
function syncShrinkDebris(){
  const history=game.shrinkHistory||[],stageKey=entry=>`${entry.face}:${entry.at}:${entry.bounds.minX}:${entry.bounds.maxX}:${entry.bounds.minY}:${entry.bounds.maxY}`;
  const currentKeys=new Set(history.map(stageKey));
  if([...seenShrinkStages].some(key=>!currentKeys.has(key)))resetFaceDebris();
  for(const entry of history){
    const key=stageKey(entry);if(seenShrinkStages.has(key))continue;seenShrinkStages.add(key);
    if(game.time-entry.at>=2.4)continue;
    for(const cell of entry.cells){
      const group=new THREE.Group(),keyOfCell=tileKey(cell.face,cell.x,cell.y);
      box(group,floorPlateMaterial,[0,-.15,0],[.98,.3,.98]);
      const tile=mesh(geometry.tile,floorDebrisMaterial,group,[0,.017,0]);
      tile.userData.isFallingFloor=true;
      box(group,faceTrim[cell.face],[0,.058,0],[.74,.018,.022]);
      const block=blocks.get(keyOfCell);
      if(block){block.removeFromParent();block.position.set(0,0,0);block.visible=true;group.add(block);blocks.delete(keyOfCell);}
      const b=entry.bounds,outward=vector(FACES[cell.face].u).multiplyScalar(cell.x<b.minX?-1:cell.x>b.maxX?1:0)
        .add(vector(FACES[cell.face].v).multiplyScalar(cell.y<b.minY?-1:cell.y>b.maxY?1:0)).normalize();
      const position=vector(worldPoint(cell.face,cell.x,cell.y)),quaternion=faceGroups[cell.face].quaternion.clone();
      scene.add(group);fallingTiles.set(`${key}:${keyOfCell}`,{group,face:cell.face,at:entry.at,position,quaternion,outward,spin:(cell.x+cell.y)%2?1:-1});
    }
  }
}
function updateShrinkDebris(){
  for(const [key,drop] of fallingTiles){
    const t=Math.max(0,game.time-drop.at);
    if(t>=2.4){drop.group.removeFromParent();fallingTiles.delete(key);continue;}
    drop.group.position.copy(drop.position).addScaledVector(drop.outward,t*.75+t*t*.25)
      .addScaledVector(vector(FACES[drop.face].n),-t*t*.24).add(new THREE.Vector3(0,-t*t*3.6,0));
    drop.group.quaternion.copy(drop.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,.4).normalize(),t*.5*drop.spin));
  }
}
function batchBlocks(){
  for(const group of blockBatches)for(const m of [...group.children]){m.removeFromParent();m.dispose();}
  scene.updateMatrixWorld(true);const batches=new Map();
  for(const g of blocks.values()){
    g.visible=false;const face=g.userData.face,inverse=faceGroups[face].matrixWorld.clone().invert();
    g.traverse(m=>{if(!m.isMesh)return;const key=`${face}:${m.geometry.uuid}:${m.material.uuid}`;if(!batches.has(key))batches.set(key,{face,geometry:m.geometry,material:m.material,transforms:[]});batches.get(key).transforms.push(inverse.clone().multiply(m.matrixWorld));});
  }
  for(const b of batches.values()){const inst=new THREE.InstancedMesh(b.geometry,b.material,b.transforms.length);b.transforms.forEach((m,i)=>inst.setMatrixAt(i,m));blockBatches[b.face].add(inst);}
}
function syncBlocks() {
  syncFaceSurfaces();syncShrinkDebris();
  const wanted = new Set();
  for(let f=0;f<6;f++) for(let y=0;y<8;y++) for(let x=0;x<8;x++) {
    if(!game.isCellActive({face:f,x,y}))continue;
    const type=game.grid[f][y][x]; if(!type) continue;
    const key=tileKey(f,x,y); wanted.add(key); if(blocks.has(key)) continue;
    const g=new THREE.Group();g.userData.face=f;g.position.set(x-3.5,0,y-3.5);faceGroups[f].add(g);
    if(type===1) {
      mesh(geometry.wall,wallMat,g,[0,.40,0]);
      box(g,wallTop,[0,.782,0],[.7,.034,.7]);
      box(g,faceTrim[f],[0,.808,-.24],[.49,.009,.023]);
      box(g,faceTrim[f],[.24,.808,0],[.023,.009,.49]);
      for(const s of [-1,1]) box(g,faceTrim[f],[s*.444,.25,.10],[.008,.045,.32]);
    } else {
      mesh(geometry.brick,brickMat,g,[0,.305,0]);
      box(g,brickTop,[0,.592,0],[.83,.035,.83]);
      const trim=brickTrims[f%2];
      for(const z of [-.436,.436]) {
        box(g,dark,[0,.29,z],[.86,.031,.008]);
        box(g,trim,[-.19,.44,z],[.3,.025,.009]);
        box(g,dark,[.16,.16,z],[.025,.23,.012]);
        box(g,dark,[-.17,.44,z],[.022,.23,.012]);
      }
      for(const angle of [-Math.PI/4,Math.PI/4]){
        const crack=box(g,trim,[0,.618,0],[.52,.012,.032]);crack.rotation.y=angle;
      }
    }
    blocks.set(key,g);
  }
  // Whole fallen faces retain scenery; removed strips own their blocks while dropping.
  for(const [k,g] of blocks) if(!wanted.has(k)&&!game.collapsedFaces.has(g.userData.face)){g.removeFromParent();blocks.delete(k);}
  batchBlocks();
}

const warningPlane=new THREE.PlaneGeometry(.97,.97);
const collapseOverlays=faceGroups.map(group=>{
  const material=new THREE.MeshBasicMaterial({color:0xff3e55,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
  const overlay=new THREE.InstancedMesh(warningPlane,material,64);overlay.count=0;overlay.frustumCulled=false;group.add(overlay);return overlay;
});
const closedEdges=faceGroups.map(group=>[0,1,2,3].map(dir=>{
  const rail=new THREE.Group();group.add(rail);
  if(dir%2)rail.rotation.y=Math.PI/2;
  const veil=new THREE.MeshBasicMaterial({color:0xff4863,transparent:true,opacity:.14,depthWrite:false,toneMapped:false});
  box(rail,veil,[0,.43,0],[8,.86,.025]);
  box(rail,neon(0xff6377),[0,.86,0],[8,.018,.028]);
  rail.visible=false;return rail;
}));
function arenaWarning(){
  const events=[game.nextCollapse&&{...game.nextCollapse,kind:'collapse'},game.nextShrink&&{...game.nextShrink,kind:'shrink'}]
    .filter(event=>event&&event.at>=game.time-1e-8&&event.at-game.time<=FACE_COLLAPSE_WARNING+1e-8);
  return events.sort((a,b)=>a.at-b.at)[0]||null;
}
function updateFaces(){
  syncFaceSurfaces();syncShrinkDebris();updateShrinkDebris();
  const warning=arenaWarning();
  if(warning&&['playing','dying','spectating'].includes(mode)){
    const seconds=Math.ceil(warning.at-game.time-1e-9),beat=`${warning.kind}:${warning.face}:${warning.at}:${seconds}`;
    if(seconds>0&&beat!==lastCollapseBeat){lastCollapseBeat=beat;beep('collapse-tick');}
  }
  for(let f=0;f<6;f++){
    const group=faceGroups[f],n=vector(FACES[f].n),fallenAt=game.faceCollapses.get(f),b=boundsFor(f);
    group.position.copy(n).multiplyScalar(4);group.quaternion.copy(faceQuaternion[f]);
    group.visible=fallenAt===undefined||game.time-fallenAt<2.4;
    const overlay=collapseOverlays[f],isWarning=warning?.face===f;
    let count=0;
    if(isWarning)for(let y=b.minY;y<=b.maxY;y++)for(let x=b.minX;x<=b.maxX;x++){
      if(warning.kind==='shrink'&&withinFaceBounds(x,y,warning.bounds))continue;
      matrix.makeRotationX(-Math.PI/2);matrix.setPosition(x-3.5,.066,y-3.5);overlay.setMatrixAt(count++,matrix);
    }
    overlay.count=count;overlay.visible=count>0;overlay.instanceMatrix.needsUpdate=true;
    overlay.material.opacity=isWarning?.12+.33*(.5+.5*Math.sin(game.time*Math.PI*5)):0;
    const wholeFaceWarning=isWarning&&warning.kind==='collapse';
    faceTrim[f].color.setHex(wholeFaceWarning&&Math.sin(game.time*Math.PI*5)>0?0xff4965:FACE_COLORS[f]);
    if(fallenAt!==undefined){
      const t=Math.max(0,game.time-fallenAt);
      group.position.addScaledVector(n,t*2+t*t*2).add(new THREE.Vector3(0,-t*t*4,0));
      group.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,.35).normalize(),t*.25));
    }else if(wholeFaceWarning){
      const intensity=1-clamp((warning.at-game.time)/FACE_COLLAPSE_WARNING,0,1);
      group.position.addScaledVector(n,Math.sin(game.time*55)*.018*intensity);
    }
    closedEdges[f].forEach((rail,dir)=>{
      const adjacent=neighbor(f,dir===1?7:dir===3?0:3,dir===2?7:dir===0?0:3,dir);
      const edgeX=dir===1?b.maxX+.5:dir===3?b.minX-.5:(b.minX+b.maxX)/2;
      const edgeY=dir===2?b.maxY+.5:dir===0?b.minY-.5:(b.minY+b.maxY)/2;
      const outward=vector(FACES[adjacent.face].n),edgePoint=vector(worldPoint(f,edgeX,edgeY));
      const hiddenSide=outward.dot(camera.position)<=outward.dot(edgePoint);
      const shrunkEdge=[b.minY>0,b.maxX<7,b.maxY<7,b.minX>0][dir];
      const closed=shrunkEdge||game.collapsedFaces.has(adjacent.face);
      rail.position.set(edgeX-3.5,0,edgeY-3.5);
      const length=dir%2?b.maxY-b.minY+1:b.maxX-b.minX+1;
      rail.children.forEach(part=>{part.scale.x=length;});
      rail.visible=fallenAt===undefined&&closed&&hiddenSide;
    });
  }
}

function antenna(parent, material, id) {
  let points;
  if(id===1) points=[[-.13,.80,0],[0,1.02,0],[.13,.80,0],[-.13,.80,0],[0,.73,0]];
  else if(id===3) {
    points=Array.from({length:25},(_,i)=>[Math.sin(i/24*Math.PI*2)*.088,.86+Math.cos(i/24*Math.PI*2)*.088,0]);
    points.push([0,.73,0]);
  } else if(id===0) points=Array.from({length:24},(_,i)=>[Math.sin(i*.25)*(.018+i*.003),.74+i*.009,0]);
  else if(id===4) points=[[0,.73,0],[0,.83,0],[-.09,.90,0],[0,.99,0],[.09,.90,0],[0,.83,0]];
  else if(id===5) points=[[0,.74,0],[0,.85,0],[-.08,.93,0],[0,.85,0],[.08,.93,0]];
  else points=[[0,.74,0],[.015,.99,0]];
  const path=new THREE.CatmullRomCurve3(points.map(vector));
  mesh(new THREE.TubeGeometry(path,32,.024,6,false),material,parent);
}
function makeCharacter(id) {
  const root=new THREE.Group(), body=new THREE.Group();root.add(body);
  const color=CHARACTERS[id].color;
  const fur=mat(color,.025,.83);
  sphere(body,fur,[0,.29,0],[.235,.28,.19]);
  sphere(body,fur,[0,.64,0],[.226,.207,.198]);
  sphere(body,skin,[0,.63,.174],[.163,.138,.052]);
  for(const sign of [-1,1]) {
    sphere(body,fur,[sign*.242,.69,-.005],[.086,.054,.044]);
    sphere(body,black,[sign*.055,.66,.224],[.016,.022,.012]);
    const arm=sphere(body,fur,[sign*.252,.33,0],[.085,.165,.085]);arm.rotation.z=sign*.38;
    const leg=sphere(body,fur,[sign*.12,.084,.04],[.098,.088,.137]);leg.name=`leg${sign}`;
  }
  sphere(body,mat(0xd7aa88),[0,.625,.238],[.025,.02,.012]);
  const smile=new THREE.EllipseCurve(0,0,.045,.020,Math.PI,Math.PI*2,false,0).getPoints(12).map(p=>new THREE.Vector3(p.x,.59+p.y,.223));
  mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(smile),12,.005,5,false),mat(0x704858),body);
  box(body,mat(0xaec3cf,.8,.28),[0,.28,.175],[.245,.18,.053]);
  box(body,dark,[0,.28,.205],[.203,.136,.012]);
  box(body,neon(color),[-.019,.28,.213],[.115,.014,.004]);
  box(body,neon(color),[.046,.302,.213],[.014,.056,.004]);
  antenna(body,fur,id);
  const ring=mesh(geometry.ring,neon(color),root,[0,.073,0]);ring.rotation.x=Math.PI/2;
  const marker=mesh(new THREE.ConeGeometry(.115,.16,4),neon(0xffe86e),root,[0,1.22,0]);marker.rotation.z=Math.PI;marker.name='you';marker.visible=id===selectedCharacter;
  root.userData.body=body;scene.add(root);return root;
}
const characterModels=CHARACTERS.map(profile=>makeCharacter(profile.id));
const characters=characterOrder.map(id=>characterModels[id]);
const deathAnimations=new Map();
function resetDeathAnimations(){
  for(const [id,animation] of deathAnimations){
    for(const {mesh:m,original,temporary} of animation.materials){m.material=original;temporary.dispose();}
    characters[id].scale.setScalar(1);
    const marker=characters[id].getObjectByName('you');if(marker)marker.visible=id===playerId;
  }
  deathAnimations.clear();
}
function applyCharacters(){
  characterOrder=onlineActive&&onlineRoom?onlineRoom.slots.map(slot=>slot.characterId):getCharacterOrder(selectedCharacter);
  characters.splice(0,characters.length,...characterOrder.map(id=>characterModels[id]));
  characterOrder.forEach((id,index)=>{
    const profile=CHARACTERS[id];COLORS[index]=profile.color;
    game.players[index].characterId=id;
    const slot=onlineActive&&onlineRoom?onlineRoom.slots[index]:null;
    game.players[index].name=`${index===playerId?'Вы · ':slot?.isBot?'Бот · ':''}${slot?.nickname||profile.name}`;
    characters[index].getObjectByName('you').visible=index===playerId;
  });
  document.documentElement.style.setProperty('--player-color',`#${COLORS[playerId].toString(16)}`);
  document.body.dataset.character=String(selectedCharacter);
  $('selected-character').textContent=CHARACTERS[selectedCharacter].name;
  for(const button of document.querySelectorAll('[data-character]'))button.setAttribute('aria-pressed',String(Number(button.dataset.character)===selectedCharacter));
  $('world').setAttribute('aria-label',`Трёхмерная арена. Ваш персонаж — ${CHARACTERS[characterOrder[playerId]].name}`);
}
function beginDeath(event){
  if(deathAnimations.has(event.id))return;
  const g=characters[event.id],materials=[];
  g.traverse(m=>{if(m.isMesh){const original=m.material,temporary=original.clone();temporary.transparent=true;temporary.depthWrite=false;m.material=temporary;materials.push({mesh:m,original,temporary});}});
  const marker=g.getObjectByName('you');if(marker)marker.visible=false;
  deathAnimations.set(event.id,{started:event.diedAt??game.time,face:event.face,x:event.x,y:event.y,cause:event.cause,position:vector(worldPoint(event.face,event.x,event.y,.06)),quaternion:faceQuaternion[event.face].clone(),heading:g.userData.body.rotation.y,materials,lastBurst:0});
}
const faceQuaternion=faceGroups.map(g=>g.quaternion.clone());
function poseAt(actor, duration=.30, crossDuration=.5) {
  const current=vector(worldPoint(actor.face,actor.x,actor.y,.06));
  let q=faceQuaternion[actor.face].clone();
  if(actor.previous && typeof actor.movedAt==='number') {
    const crossing=actor.previous.face!==actor.face;
    const t=typeof actor.stepDuration==='number'?movementProgress(actor,game.time):smooth(clamp((game.time-actor.movedAt)/(crossing ? crossDuration : duration),0,1));
    if(t<1) {
      const prev=vector(worldPoint(actor.previous.face,actor.previous.x,actor.previous.y,.06));
      if(crossing) {
        // A quadratic path follows the convex rim instead of cutting through the cube.
        const midpoint=prev.clone().add(current).multiplyScalar(.5);
        const oldN=vector(FACES[actor.previous.face].n), newN=vector(FACES[actor.face].n);
        midpoint.add(oldN.add(newN).multiplyScalar(.42));
        current.copy(prev.multiplyScalar((1-t)*(1-t)).add(midpoint.multiplyScalar(2*(1-t)*t)).add(current.clone().multiplyScalar(t*t)));
        q=faceQuaternion[actor.previous.face].clone().slerp(q,t);
      } else current.lerpVectors(prev,current,t);
    }
  }
  return {position:current,quaternion:q};
}
function updateCharacters() {
  game.players.forEach((p,i)=>{
    const g=characters[i];
    if(!p.alive){
      const death=deathAnimations.get(i);if(!death){g.visible=false;return;}
      const t=clamp((game.time-death.started)/3,0,1);g.visible=t<1;if(t>=1)return;
      g.position.copy(death.position);
      if(death.cause==='collapse'||death.cause==='shrink')g.position.addScaledVector(vector(FACES[death.face].n),t*6).add(new THREE.Vector3(0,-t*t*18,0));
      else g.position.addScaledVector(vector(FACES[death.face].n),Math.sin(t*Math.PI)*1.1+t*1.2);
      g.quaternion.copy(death.quaternion);g.scale.setScalar(1-.55*t);
      const body=g.userData.body;body.rotation.set(-t*Math.PI*2,death.heading+t*Math.PI*2,t*Math.PI*.75);body.position.y=0;
      for(const {temporary} of death.materials)temporary.opacity=1-smooth(clamp((t-.35)/.65,0,1));
      if(t-death.lastBurst>.12){burst(death.face,death.x,death.y,COLORS[i],5);death.lastBurst=t;}
      return;
    }
    g.visible=true;g.scale.setScalar(1);
    const duration=game.moveDuration(p);
    const pose=poseAt(p,duration,.5);g.position.copy(pose.position);g.quaternion.copy(pose.quaternion);
    const body=g.userData.body;
    body.rotation.x=0;
    const heading=[Math.PI,Math.PI/2,0,-Math.PI/2][p.dir||0];
    body.rotation.y=heading;
    const walking=p.previous && movementProgress(p,game.time)<1;
    body.position.y=walking ? Math.abs(Math.sin(game.time*28))*.035 : Math.sin(elapsed*2+i)*.008;
    body.rotation.z=walking ? Math.sin(game.time*24)*.055 : 0;
    const marker=g.getObjectByName('you');if(marker) marker.position.y=1.21+Math.sin(elapsed*3)*.045;
  });
}

const bombShell=mat(0x171b2c,.7,.25), bombGlow=neon(0xff7d50);
function makeBomb() {
  const g=new THREE.Group();sphere(g,bombShell,[0,.25,0],[.235,.235,.235]);
  const band=mesh(new THREE.TorusGeometry(.231,.018,6,24),bombGlow,g,[0,.25,0]);band.rotation.x=Math.PI/2;
  box(g,mat(0x697582,.8,.3),[0,.478,0],[.08,.065,.08]);
  box(g,neon(0xffd481),[.027,.547,0],[.025,.09,.024]);
  const spark=sphere(g,neon(0xffeac1),[.027,.60,0],[.052,.052,.052]);spark.name='spark';
  g.userData.shell=g.children[0];scene.add(g);return g;
}
function updateBombs() {
  const active=new Set();
  for(const bomb of game.bombs) {
    active.add(bomb.id);let g=bombMeshes.get(bomb.id);
    if(!g){g=makeBomb();bombMeshes.set(bomb.id,g);}
    const pose=poseAt(bomb,BOMB_STEP_SECONDS,BOMB_STEP_SECONDS);g.position.copy(pose.position);g.quaternion.copy(pose.quaternion);
    const pulse=1+Math.sin(elapsed*(bomb.fuse<.8?28:12))*.075;
    g.userData.shell.scale.setScalar(.235*pulse);
    g.getObjectByName('spark').scale.setScalar(.04+.022*Math.abs(Math.sin(elapsed*30)));
  }
  for(const [id,g] of bombMeshes) if(!active.has(id)){g.removeFromParent();bombMeshes.delete(id);}
}
const bonusColors={range:0xff9951,bomb:0xcf92ff,speed:0x61ffd4};
function makeBonus(type) {
  const g=new THREE.Group();
  const color=bonusColors[type]||0xffffff;
  const diamond=box(g,mat(color,.4,.2,color,.5),[0,.29,0],[.31,.31,.31]); diamond.rotation.y=Math.PI/4;
  if(type==='bomb') sphere(g,dark,[0,.29,.213],[.085,.085,.06]);
  if(type==='range') {box(g,dark,[0,.29,.22],[.17,.034,.017]);box(g,dark,[0,.29,.22],[.034,.17,.017]);}
  if(type==='speed') {const a=box(g,dark,[0,.32,.22],[.035,.14,.017]);a.rotation.z=-.42;const b=box(g,dark,[.035,.25,.22],[.035,.13,.017]);b.rotation.z=-.42;}
  const ring=mesh(new THREE.RingGeometry(.24,.27,24),neon(color),g,[0,.06,0]);ring.rotation.x=-Math.PI/2;
  scene.add(g);return g;
}
function updateBonuses() {
  const active=new Set();for(const bonus of game.bonuses) {
    const key=tileKey(bonus.face,bonus.x,bonus.y);active.add(key);let g=bonusMeshes.get(key);
    if(!g){g=makeBonus(bonus.type);bonusMeshes.set(key,g);}
    g.position.copy(vector(worldPoint(bonus.face,bonus.x,bonus.y,.07+Math.sin(elapsed*3)*.04)));g.quaternion.copy(faceQuaternion[bonus.face]);
    g.children[0].rotation.y=elapsed*.7;
  }
  for(const [id,g] of bonusMeshes) if(!active.has(id)){g.removeFromParent();bonusMeshes.delete(id);}
}

// Amber outlined cells forecast bombs; red face fills remain reserved for collapse warnings.
const dangerMaterial=new THREE.MeshBasicMaterial({color:0xffbd58,transparent:true,opacity:.22,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
const dangerOutlineMaterial=new THREE.MeshBasicMaterial({color:0xffe59a,transparent:true,opacity:.9,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
const dangerOutlineShape=new THREE.Shape();
dangerOutlineShape.moveTo(-.47,-.47);dangerOutlineShape.lineTo(.47,-.47);dangerOutlineShape.lineTo(.47,.47);dangerOutlineShape.lineTo(-.47,.47);dangerOutlineShape.closePath();
const dangerOutlineHole=new THREE.Path();
dangerOutlineHole.moveTo(-.39,-.39);dangerOutlineHole.lineTo(-.39,.39);dangerOutlineHole.lineTo(.39,.39);dangerOutlineHole.lineTo(.39,-.39);dangerOutlineHole.closePath();
dangerOutlineShape.holes.push(dangerOutlineHole);
const dangers=new THREE.InstancedMesh(geometry.decal,dangerMaterial,1600);
const dangerOutlines=new THREE.InstancedMesh(new THREE.ShapeGeometry(dangerOutlineShape),dangerOutlineMaterial,1600);
for(const [index,forecast] of [dangers,dangerOutlines].entries()){
  forecast.count=0;forecast.frustumCulled=false;forecast.renderOrder=2+index;scene.add(forecast);
}
const flameMaterial=neon(0xffb62e), flameCoreMaterial=neon(0xfff4a6);
const flames=new THREE.InstancedMesh(geometry.box,flameMaterial,1600),flameCores=new THREE.InstancedMesh(geometry.box,flameCoreMaterial,1600);
flames.count=flameCores.count=0;scene.add(flames,flameCores);
const temp=new THREE.Object3D();
function updateHazards() {
  const unique=new Set();let i=0;
  for(const bomb of game.bombs) {
    const cells=game.blastCells(bomb);
    for(const c of cells) {
      const key=tileKey(c.face,c.x,c.y);if(unique.has(key))continue;unique.add(key);
      const height=game.grid[c.face][c.y][c.x]===2?.652:.081;
      temp.position.copy(vector(worldPoint(c.face,c.x,c.y,height)));
      temp.quaternion.copy(faceQuaternion[c.face]).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2));
      temp.scale.setScalar(1);temp.updateMatrix();dangers.setMatrixAt(i,temp.matrix);
      temp.position.addScaledVector(vector(FACES[c.face].n),.003);temp.updateMatrix();dangerOutlines.setMatrixAt(i++,temp.matrix);
    }
  }
  const forecastPulse=.5+.5*Math.sin(elapsed*6);
  dangerMaterial.opacity=.18+.08*forecastPulse;dangerOutlineMaterial.opacity=.82+.16*forecastPulse;
  for(const forecast of [dangers,dangerOutlines]){forecast.count=i;forecast.instanceMatrix.needsUpdate=true;}
  i=0;for(const c of game.flames) {
    temp.position.copy(vector(worldPoint(c.face,c.x,c.y,.2)));
    temp.quaternion.copy(faceQuaternion[c.face]);
    temp.scale.set(.81,.18+Math.abs(Math.sin(elapsed*35+i))*.18,.81);temp.updateMatrix();flames.setMatrixAt(i,temp.matrix);
    temp.scale.set(.53,.42,.53);temp.updateMatrix();flameCores.setMatrixAt(i++,temp.matrix);
  }
  flames.count=flameCores.count=i;flames.instanceMatrix.needsUpdate=true;flameCores.instanceMatrix.needsUpdate=true;
}

const particles=[];const particleGeo=new THREE.BoxGeometry(.065,.065,.065);const particleMaterials=new Map();
function burst(face,x,y,color=0xffc75a,count=10) {
  const center=vector(worldPoint(face,x,y,.38)),n=vector(FACES[face].n);
  if(!particleMaterials.has(color))particleMaterials.set(color,neon(color));
  for(let i=0;i<count;i++) {
    const p=mesh(particleGeo,particleMaterials.get(color),scene);p.position.copy(center);
    const velocity=new THREE.Vector3(Math.random()-.5,Math.random()-.5,Math.random()-.5).multiplyScalar(3).add(n.clone().multiplyScalar(1.6));
    particles.push({mesh:p,velocity,ttl:.35+Math.random()*.35});
  }
}
function updateParticles(dt) {
  for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.ttl-=dt;if(p.ttl<=0){p.mesh.removeFromParent();particles.splice(i,1);continue;}p.mesh.position.addScaledVector(p.velocity,dt);p.mesh.scale.setScalar(p.ttl*1.8);p.mesh.rotation.x+=dt*5;}
}

let cameraCurrent=new THREE.Quaternion(),cameraFrom=new THREE.Quaternion(),cameraTarget=new THREE.Quaternion();
function direction(face,dir) {const f=FACES[face];return vector(dir===0?f.v:dir===1?f.u:dir===2?f.v:f.u).multiplyScalar(dir===0||dir===3?-1:1);}
function desiredFrame(face,turn) {return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(direction(face,(1+turn)%4),vector(FACES[face].n),direction(face,(2+turn)%4)));}
function turnCamera(face,turn,instant=false) {cameraFrom.copy(cameraCurrent);cameraTarget.copy(desiredFrame(face,turn));cameraTween=instant?1:0;if(instant)cameraCurrent.copy(cameraTarget);}
turnCamera(0,0,true);
function updateCamera(dt) {
  cameraTween=Math.min(1,cameraTween+dt/.5);cameraCurrent.slerpQuaternions(cameraFrom,cameraTarget,smooth(cameraTween));
  const player=mode==='spectating'?(game.players.find(p=>p.alive)||localPlayer()):localPlayer();
  if(mode==='spectating'&&cameraTarget.angleTo(desiredFrame(player.face,viewTurn))>.001)turnCamera(player.face,viewTurn);
  const position=poseAt(player).position;
  const target=position.multiplyScalar(mode==='intro'?.025:.13);
  const offset=new THREE.Vector3(8.5,15,11.5).applyQuaternion(cameraCurrent);
  if(mode==='intro')offset.applyAxisAngle(vector(FACES[0].n),Math.sin(elapsed*.18)*.055);
  camera.position.copy(target).add(offset);camera.up.copy(new THREE.Vector3(0,1,0).applyQuaternion(cameraCurrent));camera.lookAt(target);
  if(flashTime>0){camera.position.addScaledVector(new THREE.Vector3(Math.sin(elapsed*87),Math.cos(elapsed*63),0),flashTime*.025);flashTime=Math.max(0,flashTime-dt*3);}
}
function resize() {
  const w=innerWidth,h=innerHeight;renderer.setSize(w,h,false);
  const mobile=w<760&&h>w,aspect=w/h;
  let halfH=mobile ? 9.3/aspect : 9.1;
  if(mode==='intro'&&mobile)halfH=9.6/aspect;
  let vertical=mobile?halfH*.08:0;
  if(mode==='intro'&&mobile){
    const top=82,bottom=Math.max(top+140,$('intro').getBoundingClientRect().top-12);
    halfH=Math.max(halfH,h*14/(2*(bottom-top)));
    vertical=2*halfH*((top+bottom)/(2*h)-.5);
  }else if(mobile){
    const top=document.querySelector('.minimap-panel').getBoundingClientRect().bottom+8;
    const padSize=parseFloat(getComputedStyle(document.querySelector('.touch-dpad')).width)||174;
    const controlsBottom=parseFloat(getComputedStyle($('touch-controls')).bottom)||15;
    const bottom=Math.max(top+140,h-padSize-controlsBottom-12);
    halfH=Math.max(halfH,h*15/(2*(bottom-top)));
    vertical=2*halfH*((top+bottom)/(2*h)-.5);
  }
  const halfW=halfH*aspect;
  const shift=mode==='intro'&&!mobile?-halfW*.32:!mobile?-halfW*.015:0;
  camera.left=-halfW+shift;camera.right=halfW+shift;camera.top=halfH+vertical;camera.bottom=-halfH+vertical;camera.updateProjectionMatrix();
}
addEventListener('resize',resize);resize();

const netPositions=[[1,0],[1,1],[2,1],[3,1],[0,1],[1,2]];
const mini=$('minimap'),ctx=mini.getContext('2d');
function drawMinimap() {
  const width=mini.width,height=mini.height,unit=Math.min((width-16)/32,(height-12)/24),faceSize=8*unit;
  const ox=(width-faceSize*4)/2,oy=(height-faceSize*3)/2,player=localPlayer(),warning=arenaWarning();
  ctx.clearRect(0,0,width,height);
  for(let f=0;f<6;f++) {
    const [nx,ny]=netPositions[f],sx=ox+nx*faceSize,sy=oy+ny*faceSize;
    if(game.collapsedFaces.has(f)){
      ctx.fillStyle='#090e18';ctx.fillRect(sx+1,sy+1,faceSize-2,faceSize-2);
      ctx.strokeStyle='#50313e';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(sx+6,sy+6);ctx.lineTo(sx+faceSize-6,sy+faceSize-6);ctx.moveTo(sx+faceSize-6,sy+6);ctx.lineTo(sx+6,sy+faceSize-6);ctx.stroke();continue;
    }
    const b=boundsFor(f),left=sx+b.minX*unit,top=sy+b.minY*unit,w=(b.maxX-b.minX+1)*unit,h=(b.maxY-b.minY+1)*unit;
    ctx.fillStyle=f===player.face?'#253847':'#131e2c';ctx.fillRect(left+1,top+1,w-2,h-2);
    for(let y=b.minY;y<=b.maxY;y++)for(let x=b.minX;x<=b.maxX;x++) {
      if(warning?.face===f&&(warning.kind==='collapse'||!withinFaceBounds(x,y,warning.bounds))){
        ctx.fillStyle=`rgba(255,65,87,${.2+.25*(.5+.5*Math.sin(game.time*Math.PI*5))})`;ctx.fillRect(sx+x*unit+.5,sy+y*unit+.5,unit-1,unit-1);
      }
      const t=game.grid[f][y][x];if(!t)continue;ctx.fillStyle=t===1?'#46647c':'#f28a48';ctx.fillRect(sx+x*unit+1.2,sy+y*unit+1.2,unit-2,unit-2);
    }
    ctx.strokeStyle=f===player.face?`#${COLORS[playerId].toString(16)}`:'#304456';ctx.lineWidth=f===player.face?1.5:1;ctx.strokeRect(left+1,top+1,w-2,h-2);
  }
  const dot=(c,color,r=1)=>{
    if(!game.isCellActive(c))return;
    const [nx,ny]=netPositions[c.face];ctx.fillStyle=color;ctx.fillRect(ox+(nx*8+c.x+.5)*unit-unit*r/2,oy+(ny*8+c.y+.5)*unit-unit*r/2,unit*r,unit*r);
  };
  for(const b of game.bombs){for(const c of game.blastCells(b))dot(c,'#ed715a66',.8);dot(bombExplosionCell(b,game.time),Math.sin(elapsed*12)>0?'#fff0b0':'#fb724c',.9);}
  for(const b of game.bonuses)dot(b,'#77e9ba',.55);
  for(const c of game.flames)dot(c,'#ffd977',1);
  for(const p of game.players)if(p.alive)dot(p,`#${COLORS[p.id].toString(16)}`,p.id===playerId?1.18:.9);
}
function beep(type,id=playerId){audio.event(type,characterOrder[id]??selectedCharacter);}
function soundUI(){
  $('sound').setAttribute('aria-label',soundEnabled?'Выключить звук':'Включить звук');$('sound').setAttribute('aria-pressed',String(soundEnabled));$('sound').classList.toggle('muted',!soundEnabled);
}
function syncMusic(){audio.setPlaying(!document.hidden&&['intro','online','countdown','playing','dying','finish','spectating'].includes(mode));}
async function unlockAudio(autoplay=false){
  if(!soundEnabled)return false;
  const ready=await audio.start({autoplay});syncMusic();soundUI();return ready;
}
soundUI();
function updateHud(force=false) {
  if(!force&&elapsed-lastHud<.12)return;lastHud=elapsed;
  const p=localPlayer(),alive=game.players.filter(a=>a.alive).length;
  $('alive-count').textContent=`${alive} / 6`;
  $('range-value').textContent=p.range;$('bomb-value').textContent=`${game.bombs.filter(b=>b.owner===playerId).length} / ${p.capacity}`;
  $('speed-value').textContent=`×${(1+(p.speed-1)*.07).toFixed(2)}`;
  $('roster').innerHTML=game.players.map(a=>`<div class="roster-player${a.alive?'':' eliminated'}${a.id===playerId?' is-you':''}"><i style="--player-color:#${COLORS[a.id].toString(16)}"></i><span>${escapeHtml(a.name)}</span><small>${a.alive?(a.face===p.face?'ЗДЕСЬ':FACES[a.face].name):'ВЫБЫЛ'}</small></div>`).join('');
  drawMinimap();
}
function setMode(next) {
  mode=next;keys.clear();
  clearTouchInput();
  if(onlineActive)sendDirection(null,true);
  syncMusic();
  $('intro').classList.toggle('hidden',next!=='intro');$('hud').classList.toggle('hidden',next==='intro'||next==='online');
  $('online-panel').classList.toggle('hidden',next!=='online');
  $('pause-panel').classList.toggle('hidden',next!=='paused');$('finish-panel').classList.toggle('hidden',next!=='finish');$('help-panel').classList.toggle('hidden',next!=='help');
  $('countdown').classList.toggle('hidden',next!=='countdown');
  $('death-announcement').classList.toggle('hidden',next!=='dying');
  $('pause').classList.toggle('hidden',onlineActive||['intro','online','finish','dying'].includes(next));$('touch-controls').classList.toggle('hidden',next!=='playing');
  document.querySelector('#finish-panel .modal-shortcut').classList.toggle('hidden',onlineActive);
  if(['playing','countdown','spectating'].includes(next))$('world').focus({preventScroll:true});
  document.body.dataset.mode=next;resize();
}
function resetRound(){
  resetDeathAnimations();
  game.multiplayer=false;game.humanIds=new Set([0]);game.botsEnabled=true;
  game.reset(Date.now());viewTurn=0;turnCamera(localPlayer().face,0,true);
  lastCollapseBeat=null;updateFaces();
  applyCharacters();
  for(const g of blocks.values())g.removeFromParent();blocks.clear();syncBlocks();
  for(const {mesh:m} of particles)m.removeFromParent();particles.length=0;
  nextVoice=7;
}
function start() {
  if(onlineActive){if(onlineRoom?.phase==='finished'){setMode('online');renderOnlineRoom();}else setMode('spectating');return;}
  resetRound();
  countdownRemaining=3;lastCountdownNumber=3;$('countdown-number').textContent='3';
  setMode('countdown');unlockAudio().then(()=>{if(mode==='countdown')beep('countdown');});updateHud(true);$('world').focus();
}
function returnToMenu(){if(onlineActive)leaveOnline();else{resetRound();setMode('intro');updateHud(true);document.querySelector(`[data-character="${selectedCharacter}"]`).focus();}}
function pauseGame(){if(onlineActive){sendDirection(null,true);return;}if(mode==='playing'||mode==='countdown'){pauseReturn=mode;setMode('paused');}}
function resumeGame(){setMode(pauseReturn);$('world').focus();}
function finish() {
  const p=localPlayer(),won=onlineActive?game.winnerId===playerId:game.status==='won';
  $('finish-title').textContent=won?'Победа!':`Место игрока: ${p.place??6}-е`;
  $('finish-description').textContent=won?'Ты пережил всех соперников. Куб твой!':'';
  $('finish-stats').textContent='';
  $('restart').textContent=onlineActive?(onlineRoom?.phase==='finished'?'В комнату':'Наблюдать'):'Сыграть ещё';
  $('choose-character-finish').textContent=onlineActive?'Выйти из комнаты':'Выбрать персонажа';
  onlineResultShown=onlineActive;
  setMode('finish');
  if(won)beep('victory');
}
function handleEvents() {
  for(const event of game.events.splice(0)) {
    if((event.type==='move'||event.type==='collapse-return')&&event.id===playerId&&event.from.face!==event.to.face) {
      viewTurn=(viewTurn+event.dir-event.previousDir+4)%4;turnCamera(event.to.face,viewTurn);
    }
    if(event.type==='bomb'||event.type==='kick'||event.type==='bonus'||event.type==='death')beep(event.type,event.owner??event.id??0);
    if(event.type==='death'){beginDeath(event);burst(event.face,event.x,event.y,COLORS[event.id],20);if(event.id===playerId&&mode!=='finish'&&mode!=='spectating')setMode('dying');}
    if(event.type==='explode') {beep('explode');flashTime=.5;if(event.face!==undefined)burst(event.face,event.x,event.y);syncBlocks();}
    if(event.type==='collapse'){
      beep('collapse');flashTime=1.4;
      for(let x=0;x<8;x+=2)for(const y of [0,7])burst(event.face,x,y,0xff6c55,8);
      for(let y=2;y<7;y+=2)for(const x of [0,7])burst(event.face,x,y,0xff6c55,8);
      syncBlocks();updateHud(true);
    }
    if(event.type==='shrink'){
      beep('collapse');flashTime=1;
      for(const cell of event.cells)burst(cell.face,cell.x,cell.y,0xff6c55,4);
      syncBlocks();updateHud(true);
    }
  }
}
const pageParameters=new URLSearchParams(location.search);
let serverAddress=CUBE_SERVER_URL;
if(pageParameters.has('server')){
  try{const candidate=new URL(pageParameters.get('server'));if(['http:','https:','ws:','wss:'].includes(candidate.protocol))serverAddress=candidate.href;}catch{}
}
function showOnlineStatus(message){$('online-status').textContent=message;}
function renderOnlineRoom(){
  const room=onlineRoom;
  $('online-entry').classList.toggle('hidden',Boolean(room));
  $('online-lobby').classList.toggle('hidden',!room);
  if(!room)return;
  const host=room.hostId===memberId;
  $('online-room-code').textContent=room.roomId;
  $('online-roster').innerHTML=room.slots.map(slot=>`<div class="${slot.id===playerId?'is-you ':''}${slot.isBot?'is-bot':''}"><i style="--player-color:#${CHARACTERS[slot.characterId].color.toString(16)}"></i><span>${escapeHtml(slot.nickname)}<small>${escapeHtml(CHARACTERS[slot.characterId].name)}</small></span><small>${slot.memberId===room.hostId?'ХОЗЯИН':slot.memberId===memberId?'ВЫ':slot.connected?'ГОТОВ':slot.memberId?'НЕТ СВЯЗИ':'БОТ'}</small></div>`).join('');
  $('online-start').disabled=!host||!['lobby','finished'].includes(room.phase)||connectionState!=='connected';
  $('online-start').textContent=room.phase==='finished'?(host?'Новая партия':'Ждём хозяина комнаты'):room.phase==='lobby'?(host?'Начать матч':'Ждём хозяина комнаты'):'Матч идёт';
  if(connectionState==='connected')showOnlineStatus(room.phase==='lobby'?`${room.members.filter(m=>m.connected).length} из 6 игроков`:(room.phase==='finished'?'Матч завершён':'Матч идёт'));
}
function connectionStatus(status){
  connectionState=status;
  const message={connecting:'Подключаемся…',reconnecting:'Восстанавливаем соединение…',disconnected:'Соединение потеряно',connected:''}[status]||'';
  $('online-connection').textContent=message;
  $('online-connection').classList.toggle('hidden',!onlineActive||!message||mode==='online');
  if(message)showOnlineStatus(message);
  if(status==='reconnecting'||status==='disconnected'){keys.clear();clearTouchInput();}
  renderOnlineRoom();
}
function handleOnlineMessage(packet){
  if(!onlineActive)return;
  if(packet.type==='welcome'){
    playerId=packet.playerId;memberId=packet.memberId;
    networkRound=-1;networkTick=-1;lastInputDir=null;lastInputAt=-Infinity;
    $('online-code').value=packet.roomId;
  }
  if(packet.type==='room'){
    const previousPhase=onlineRoom?.phase;onlineRoom=packet;renderOnlineRoom();
    if(packet.phase==='lobby'){
      resetDeathAnimations();applyCharacters();
      if(previousPhase&&previousPhase!=='lobby'){networkRound=-1;networkTick=-1;resetRound();}
      if(mode!=='online')setMode('online');
    }
    if(packet.phase==='finished'&&mode==='finish')$('restart').textContent='В комнату';
  }
  if(packet.type==='state')applyOnlineState(packet);
  if(['closed','left','replaced'].includes(packet.type)){
    const message=packet.message||'Комната закрыта.';leaveOnline();openOnline();showOnlineStatus(message);
  }
}
function applyOnlineState(packet){
  if(!onlineRoom||packet.roundId<networkRound||(packet.roundId===networkRound&&packet.tick<networkTick))return;
  const fresh=packet.roundId!==networkRound;
  if(fresh){
    resetDeathAnimations();
    for(const g of blocks.values())g.removeFromParent();blocks.clear();
    for(const {mesh:m} of particles)m.removeFromParent();particles.length=0;
    networkRound=packet.roundId;lastEventId=0;onlineResultShown=false;lastCollapseBeat=null;lastCountdownNumber=0;nextVoice=7;
    lastInputAt=-Infinity;lastInputDir=null;
  }
  networkTick=packet.tick;
  const oldGrid=JSON.stringify(game.grid),oldBounds=JSON.stringify(game.faceBounds);
  applySnapshot(game,packet.state);
  snapshotTime=game.time;snapshotReceivedAt=elapsed;
  if(fresh){applyCharacters();viewTurn=0;turnCamera(localPlayer().face,0,true);updateFaces();syncBlocks();}
  else if(oldGrid!==JSON.stringify(game.grid)||oldBounds!==JSON.stringify(game.faceBounds))syncBlocks();
  for(const actor of game.players){const slot=onlineRoom.slots[actor.id];actor.name=`${actor.id===playerId?'Вы · ':slot.isBot?'Бот · ':''}${slot.nickname}`;}
  const events=(packet.events||[]).filter(event=>event.eventId>lastEventId);
  if(events.length)lastEventId=Math.max(...events.map(event=>event.eventId));
  game.events=events;handleEvents();
  for(const actor of game.players)if(!actor.alive&&!deathAnimations.has(actor.id)&&game.time-actor.diedAt<3)beginDeath({id:actor.id,face:actor.face,x:actor.x,y:actor.y,diedAt:actor.diedAt});
  if(packet.phase==='countdown'){
    countdownRemaining=Math.max(0,(packet.startAt-packet.serverTime)/1000);
    const number=Math.max(1,Math.ceil(countdownRemaining));$('countdown-number').textContent=String(number);
    if(number!==lastCountdownNumber){lastCountdownNumber=number;beep('countdown');}
    if(mode!=='countdown')setMode('countdown');
  }else if(['online','countdown'].includes(mode)){
    setMode(localPlayer().alive?'playing':onlineResultShown?'spectating':'dying');
    if(lastCountdownNumber){beep('start');lastCountdownNumber=0;}
  }
  if(!localPlayer().alive&&!onlineResultShown&&mode!=='dying')setMode('dying');
  updateHud(true);
}
function ensureOnlineClient(){
  if(onlineClient)return onlineClient;
  onlineClient=new CubeClient({url:serverAddress,onMessage:handleOnlineMessage,onStatus:connectionStatus,onError:packet=>{
    showOnlineStatus(packet.message||'Не удалось войти в комнату.');
    if(['room_not_found','reconnect_expired'].includes(packet.code)){onlineRoom=null;$('online-lobby').classList.add('hidden');if(mode!=='online')setMode('online');}
  }});
  return onlineClient;
}
function openOnline(){
  if(!onlineActive){$('online-lobby').classList.add('hidden');showOnlineStatus('');}
  try{$('online-name').value=localStorage.getItem('cube-bomber-nickname')||CHARACTERS[selectedCharacter].name;}catch{}
  renderOnlineRoom();setMode('online');
}
async function enterOnline(join){
  const nickname=$('online-name').value.trim()||CHARACTERS[selectedCharacter].name,roomId=$('online-code').value.trim().toUpperCase();
  if(join&&!/^[A-F0-9]{8}$/.test(roomId)){showOnlineStatus('Введи код комнаты из 8 символов.');return;}
  try{localStorage.setItem('cube-bomber-nickname',nickname);}catch{}
  onlineActive=true;onlineResultShown=false;networkRound=-1;networkTick=-1;
  $('online-create').disabled=$('online-join').disabled=true;
  try{const client=ensureOnlineClient();if(join)await client.join({roomId,nickname,characterId:selectedCharacter});else await client.create({nickname,characterId:selectedCharacter});}
  catch(error){showOnlineStatus(error.message||'Сервер недоступен. Попробуй ещё раз.');}
  finally{$('online-create').disabled=$('online-join').disabled=false;}
}
function leaveOnline(){
  onlineActive=false;onlineClient?.destroy();onlineClient=null;onlineRoom=null;memberId=null;playerId=0;
  networkRound=-1;networkTick=-1;lastEventId=0;onlineResultShown=false;
  $('online-connection').classList.add('hidden');$('online-lobby').classList.add('hidden');
  resetRound();setMode('intro');updateHud(true);
}
$('online-open').addEventListener('click',openOnline);
$('online-close').addEventListener('click',()=>{if(onlineActive)leaveOnline();else setMode('intro');});
$('online-create').addEventListener('click',()=>enterOnline(false));
$('online-join').addEventListener('click',()=>enterOnline(true));
$('online-leave').addEventListener('click',leaveOnline);
$('online-start').addEventListener('click',()=>{if(onlineRoom?.phase==='finished')onlineClient?.returnLobby();else{unlockAudio();onlineClient?.start();}});
$('online-invite').addEventListener('click',async()=>{
  if(!onlineRoom)return;
  const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('room',onlineRoom.roomId);
  if(serverAddress!==CUBE_SERVER_URL)url.searchParams.set('server',serverAddress);
  try{await navigator.clipboard.writeText(url.href);showOnlineStatus('Ссылка скопирована');}
  catch{showOnlineStatus(`Код комнаты: ${onlineRoom.roomId}`);}
});
$('start').addEventListener('click',start);
$('restart').addEventListener('click',start);$('restart-pause').addEventListener('click',start);
$('choose-character-pause').addEventListener('click',returnToMenu);
$('choose-character-finish').addEventListener('click',returnToMenu);
for(const button of document.querySelectorAll('[data-character]'))button.addEventListener('click',()=>{
  if(mode!=='intro')return;
  const id=Number(button.dataset.character);selectedCharacter=getCharacterOrder(id)[0];
  try{localStorage.setItem('cube-bomber-character',String(selectedCharacter));}catch{}
  applyCharacters();updateHud(true);
  unlockAudio().then(()=>{if(mode==='intro'&&selectedCharacter===id)audio.event('select',id);});
});
$('resume').addEventListener('click',resumeGame);
$('pause').addEventListener('click',()=>{if(mode==='paused')resumeGame();else pauseGame();});
$('sound').addEventListener('click',()=>{soundEnabled=!soundEnabled;audio.setEnabled(soundEnabled);soundUI();try{localStorage.setItem('cube-bomber-sound',soundEnabled?'on':'off');}catch{}if(soundEnabled)unlockAudio();});
for(const button of document.querySelectorAll('#help, #help-pause, #help-finish'))button.addEventListener('click',()=>{if(mode==='help'){setMode(helpReturn);return;}helpReturn=mode;setMode('help');});
$('close-help').addEventListener('click',()=>setMode(helpReturn));
const codeDirs={ArrowUp:0,KeyW:0,ArrowRight:1,KeyD:1,ArrowDown:2,KeyS:2,ArrowLeft:3,KeyA:3};
function currentDirection(){
  const touch=touchInput.direction,key=[...keys].at(-1);
  const dir=touch??codeDirs[key];return dir===undefined?null:(dir+viewTurn)%4;
}
function sendDirection(dir,force=false){
  if(!onlineActive||!onlineClient)return;
  if(force||dir!==lastInputDir||elapsed-lastInputAt>=.15){onlineClient.input(dir);lastInputDir=dir;lastInputAt=elapsed;}
}
function pressBomb(){
  if(mode!=='playing'||!localPlayer().alive)return;
  lastBombInputAt=elapsed;
  if(onlineActive)onlineClient?.bomb();else game.placeBomb(playerId);
}
function updateTouchHighlights(){
  for(const b of document.querySelectorAll('[data-dir]'))b.classList.toggle('pressed',touchInput.hasDirection(Number(b.dataset.dir)));
  $('touch-bomb').classList.toggle('pressed',touchInput.bombHeld);
}
function clearTouchInput(){touchInput.clear();updateTouchHighlights();}
addEventListener('keydown',e=>{
  if(e.target.closest?.('input,textarea,select'))return;
  if(['Space','Enter'].includes(e.code)&&e.target.closest?.('button,a,input,select,textarea'))return;
  if(mode==='playing'&&['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
  if(e.repeat&&['Space','KeyQ','KeyE','Escape','KeyP','Enter'].includes(e.code))return;
  if(e.code==='Escape'||e.code==='KeyP') {if(mode==='paused')resumeGame();else if(mode==='help')setMode(helpReturn);else pauseGame();return;}
  if(e.code==='Enter'&&(mode==='intro'||mode==='finish')){start();return;}
  if(e.code==='KeyR'&&mode==='finish'){start();return;}
  if((mode==='playing'||mode==='spectating')&&(e.code==='KeyQ'||e.code==='KeyE')&&cameraTween>=1){viewTurn=(viewTurn+(e.code==='KeyQ'?3:1))%4;turnCamera((mode==='spectating'?game.players.find(p=>p.alive):localPlayer())?.face??localPlayer().face,viewTurn);}
  if(mode!=='playing')return;
  if(e.code in codeDirs){keys.delete(e.code);keys.add(e.code);moveInput();}
  if(e.code==='Space')pressBomb();
});
addEventListener('keyup',e=>{keys.delete(e.code);if(onlineActive)sendDirection(mode==='playing'?currentDirection():null,true);});
addEventListener('blur',()=>{keys.clear();clearTouchInput();pauseGame();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){keys.clear();clearTouchInput();pauseGame();}syncMusic();});
for(const gesture of ['pointerdown','keydown'])document.addEventListener(gesture,e=>{
  if(!audio.isReady&&soundEnabled&&!e.target.closest?.('#sound'))unlockAudio();
},{capture:true});
for(const b of document.querySelectorAll('[data-dir]')) {
  b.addEventListener('pointerdown',e=>{e.preventDefault();if(mode!=='playing')return;b.setPointerCapture(e.pointerId);touchInput.pressDirection(e.pointerId,Number(b.dataset.dir));updateTouchHighlights();moveInput();});
  b.addEventListener('lostpointercapture',e=>{touchInput.release(e.pointerId);updateTouchHighlights();if(onlineActive)sendDirection(mode==='playing'?currentDirection():null,true);});
}
$('touch-bomb').addEventListener('pointerdown',e=>{e.preventDefault();if(mode!=='playing')return;e.currentTarget.setPointerCapture(e.pointerId);touchInput.pressBomb(e.pointerId);updateTouchHighlights();pressBomb();});
$('touch-bomb').addEventListener('lostpointercapture',e=>{touchInput.release(e.pointerId);updateTouchHighlights();});
for(const type of ['pointerup','pointercancel'])addEventListener(type,e=>{touchInput.release(e.pointerId);updateTouchHighlights();if(onlineActive)sendDirection(mode==='playing'?currentDirection():null,true);});
$('touch-controls').addEventListener('contextmenu',e=>e.preventDefault());
function moveInput() {
  if(document.hidden){if(onlineActive)sendDirection(null);return;}
  const dir=currentDirection();
  if(onlineActive){sendDirection(dir);return;}
  if(cameraTween>=1&&dir!==null)game.move(playerId,dir);
}
applyCharacters();syncBlocks();updateHud(true);setMode('intro');unlockAudio(true);
if(pageParameters.has('room')){$('online-code').value=pageParameters.get('room').toUpperCase();openOnline();}
let previous=performance.now();
function frame(now) {
  requestAnimationFrame(frame);const wallDt=(now-previous)/1000,dt=Math.min(wallDt,.05);previous=now;elapsed+=dt;
  if(mode==='countdown'&&!onlineActive){
    countdownRemaining=Math.max(0,countdownRemaining-wallDt);
    const number=Math.ceil(countdownRemaining);
    if(number!==lastCountdownNumber&&number>0){lastCountdownNumber=number;$('countdown-number').textContent=String(number);beep('countdown');}
    if(countdownRemaining<=0){setMode('playing');beep('start');}
  }
  if(onlineActive&&networkRound>=0){
    const sinceSnapshot=elapsed-snapshotReceivedAt;
    game.time=game.status==='finished'?Math.min((game.endedAt??snapshotTime)+3,snapshotTime+sinceSnapshot):snapshotTime+Math.min(sinceSnapshot,.1);
    if(mode==='playing')moveInput();
    if(!onlineResultShown&&!localPlayer().alive&&game.time>=localPlayer().diedAt+3-1e-6)finish();
    else if(game.status==='finished'&&game.time>=(game.endedAt??game.time)+3-1e-6&&mode!=='finish'&&mode!=='online')finish();
  }else if(mode==='playing'||mode==='dying'){
    game.update(dt);if(mode==='playing')moveInput();handleEvents();
    if(game.time>nextVoice){const candidates=game.players.filter(p=>p.alive);beep('voice',candidates[Math.floor(Math.random()*candidates.length)]?.id||0);nextVoice=game.time+7+Math.random()*5;}
    if(game.status==='lost'&&mode==='playing')setMode('dying');
    if(game.status==='won'||(mode==='dying'&&game.time-localPlayer().diedAt>=3))finish();
  }
  if(mode==='playing'&&!document.hidden&&touchInput.bombHeld&&elapsed-lastBombInputAt>=.16)pressBomb();
  updateCamera(dt);updateFaces();updateCharacters();updateBombs();updateBonuses();updateHazards();updateParticles(dt);updateHud();renderer.render(scene,camera);
}
requestAnimationFrame(frame);
