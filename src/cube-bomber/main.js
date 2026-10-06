import * as THREE from 'three';
import { Game, FACES, SIZE, worldPoint, tileKey, neighbor, BOMB_STEP_SECONDS, FACE_COLLAPSE_WARNING, movementProgress, bombExplosionCell } from './engine.js';
import { GameAudio } from './audio.js';
import { CHARACTERS, getCharacterOrder } from './characters.js';

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
let mode = 'intro', helpReturn = 'intro', pauseReturn = 'playing', viewTurn = 0, elapsed = 0, lastHud = 0, cameraTween = 1;
let soundEnabled = true, flashTime = 0, nextVoice = 7, countdownRemaining = 0, lastCountdownNumber = 0, lastCollapseBeat = null;
try { soundEnabled = localStorage.getItem('cube-bomber-sound') !== 'off'; } catch {}
const audio = new GameAudio();audio.setEnabled(soundEnabled);
const keys = new Set();
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
for(let f = 0; f < 6; f++) {
  const group = faceGroups[f];
  box(group, mat(0x121d32, .7, .35), [0,-.15,0], [8.03,.3,8.03]);
  const tiles = new THREE.InstancedMesh(geometry.tile, mat(0xffffff, .55, .48), 64);
  for(let y=0; y<SIZE; y++) for(let x=0; x<SIZE; x++) {
    matrix.makeTranslation(x-3.5,.017,y-3.5); const i=y*8+x; tiles.setMatrixAt(i,matrix);
    tiles.setColorAt(i,new THREE.Color((x+y)%2 ? 0x24364d : 0x1b2a40));
  }
  group.add(tiles);
  for(let i=0;i<9;i++) {
    box(group, mat(FACE_COLORS[f],.5,.4,FACE_COLORS[f],.3), [i-4,.026,0],[.018,.012,8]);
    box(group, mat(FACE_COLORS[f],.5,.4,FACE_COLORS[f],.3), [0,.026,i-4],[8,.012,.018]);
  }
  // Segmented rim reads as a seam, while every edge cell remains traversable.
  for(let side=0;side<4;side++) for(let i=0;i<8;i++) {
    const segment=box(group,faceTrim[f],[0,.055,0],[.018,.023,.46]);
    if(side<2) segment.position.set(side ? 3.985 : -3.985,.055,i-3.5);
    else {segment.rotation.y=Math.PI/2;segment.position.set(i-3.5,.055,side===2 ? -3.985 : 3.985);}
  }
  // Four central cells make the even-sized board's starting zone readable.
  for(const [x,y] of [[3,3],[3,4],[4,3],[4,4]]) {
    const r=mesh(new THREE.RingGeometry(.29,.31,32),faceTrim[f],group,[x-3.5,.055,y-3.5]);r.rotation.x=-Math.PI/2;
  }
}

const blocks = new Map(), bombMeshes = new Map(), bonusMeshes = new Map();
const blockBatches=faceGroups.map(face=>{const group=new THREE.Group();face.add(group);return group;});
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
  const wanted = new Set();
  for(let f=0;f<6;f++) for(let y=0;y<8;y++) for(let x=0;x<8;x++) {
    if(game.collapsedFaces.has(f))continue;
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
  // Fallen panels retain their scenery until their departure animation is over.
  for(const [k,g] of blocks) if(!wanted.has(k)&&!game.collapsedFaces.has(g.userData.face)){g.removeFromParent();blocks.delete(k);}
  batchBlocks();
}

const collapseOverlays=faceGroups.map(group=>{
  const material=new THREE.MeshBasicMaterial({color:0xff3e55,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
  const overlay=mesh(new THREE.PlaneGeometry(7.95,7.95),material,group,[0,.064,0]);overlay.rotation.x=-Math.PI/2;overlay.visible=false;return overlay;
});
const closedEdges=faceGroups.map(group=>[0,1,2,3].map(dir=>{
  const rail=new THREE.Group();group.add(rail);
  rail.position.set(dir===1?3.99:dir===3?-3.99:0,0,dir===2?3.99:dir===0?-3.99:0);
  if(dir%2)rail.rotation.y=Math.PI/2;
  const veil=new THREE.MeshBasicMaterial({color:0xff4863,transparent:true,opacity:.14,depthWrite:false,toneMapped:false});
  box(rail,veil,[0,.43,0],[8,.86,.025]);
  box(rail,neon(0xff6377),[0,.86,0],[8,.018,.028]);
  rail.visible=false;return rail;
}));
function updateFaces(){
  const warning=game.nextCollapse&&game.nextCollapse.at-game.time<=FACE_COLLAPSE_WARNING;
  if(warning&&(mode==='playing'||mode==='dying')){
    const seconds=Math.ceil(game.nextCollapse.at-game.time-1e-9),beat=`${game.nextCollapse.face}:${seconds}`;
    if(seconds>0&&beat!==lastCollapseBeat){lastCollapseBeat=beat;beep('collapse-tick');}
  }
  for(let f=0;f<6;f++){
    const group=faceGroups[f],n=vector(FACES[f].n),fallenAt=game.faceCollapses.get(f);
    group.position.copy(n).multiplyScalar(4);group.quaternion.copy(faceQuaternion[f]);
    group.visible=fallenAt===undefined||game.time-fallenAt<2.4;
    const overlay=collapseOverlays[f],isWarning=warning&&game.nextCollapse.face===f;
    overlay.visible=Boolean(isWarning);overlay.material.opacity=isWarning?.12+.33*(.5+.5*Math.sin(game.time*Math.PI*5)):0;
    faceTrim[f].color.setHex(isWarning&&Math.sin(game.time*Math.PI*5)>0?0xff4965:FACE_COLORS[f]);
    if(fallenAt!==undefined){
      const t=Math.max(0,game.time-fallenAt);
      group.position.addScaledVector(n,t*2+t*t*2).add(new THREE.Vector3(0,-t*t*4,0));
      group.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,.35).normalize(),t*.25));
    }else if(isWarning){
      const intensity=1-clamp((game.nextCollapse.at-game.time)/FACE_COLLAPSE_WARNING,0,1);
      group.position.addScaledVector(n,Math.sin(game.time*55)*.018*intensity);
    }
    closedEdges[f].forEach((rail,dir)=>{
      const cell=neighbor(f,dir===1?7:dir===3?0:3,dir===2?7:dir===0?0:3,dir);
      const hiddenSide=vector(FACES[cell.face].n).dot(camera.position)<=SIZE/2;
      rail.visible=fallenAt===undefined&&game.collapsedFaces.has(cell.face)&&hiddenSide;
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
    const marker=characters[id].getObjectByName('you');if(marker)marker.visible=id===0;
  }
  deathAnimations.clear();
}
function applyCharacters(){
  characterOrder=getCharacterOrder(selectedCharacter);
  characters.splice(0,characters.length,...characterOrder.map(id=>characterModels[id]));
  characterOrder.forEach((id,index)=>{
    const profile=CHARACTERS[id];COLORS[index]=profile.color;
    game.players[index].characterId=id;
    game.players[index].name=`${index===0?'Вы · ':''}${profile.name}`;
    characters[index].getObjectByName('you').visible=index===0;
  });
  document.documentElement.style.setProperty('--player-color',`#${COLORS[0].toString(16)}`);
  document.body.dataset.character=String(selectedCharacter);
  $('selected-character').textContent=CHARACTERS[selectedCharacter].name;
  for(const button of document.querySelectorAll('[data-character]'))button.setAttribute('aria-pressed',String(Number(button.dataset.character)===selectedCharacter));
  $('world').setAttribute('aria-label',`Трёхмерная арена. Ваш персонаж — ${CHARACTERS[selectedCharacter].name}`);
}
function beginDeath(event){
  const g=characters[event.id],materials=[];
  g.traverse(m=>{if(m.isMesh){const original=m.material,temporary=original.clone();temporary.transparent=true;temporary.depthWrite=false;m.material=temporary;materials.push({mesh:m,original,temporary});}});
  const marker=g.getObjectByName('you');if(marker)marker.visible=false;
  deathAnimations.set(event.id,{started:game.time,face:event.face,x:event.x,y:event.y,cause:event.cause,position:vector(worldPoint(event.face,event.x,event.y,.06)),quaternion:faceQuaternion[event.face].clone(),heading:g.userData.body.rotation.y,materials,lastBurst:0});
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
      if(death.cause==='collapse')g.position.addScaledVector(vector(FACES[death.face].n),t*6).add(new THREE.Vector3(0,-t*t*18,0));
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

const dangerMaterial=new THREE.MeshBasicMaterial({color:0xff4d61,transparent:true,opacity:.22,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
const dangers=new THREE.InstancedMesh(geometry.decal,dangerMaterial,1600);dangers.count=0;scene.add(dangers);
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
      temp.position.copy(vector(worldPoint(c.face,c.x,c.y,.071)));
      temp.quaternion.copy(faceQuaternion[c.face]).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2));
      temp.scale.setScalar(.94);temp.updateMatrix();dangers.setMatrixAt(i++,temp.matrix);
    }
  }
  dangers.count=i;dangers.instanceMatrix.needsUpdate=true;dangerMaterial.opacity=.17+Math.sin(elapsed*8)*.055;
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
  const player=game.players[0];const position=poseAt(player).position;
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
  let vertical=mobile?-halfH*.04:0;
  if(mode==='intro'&&mobile){
    const top=82,bottom=Math.max(top+140,$('intro').getBoundingClientRect().top-12);
    halfH=Math.max(halfH,h*14/(2*(bottom-top)));
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
  const ox=(width-faceSize*4)/2,oy=(height-faceSize*3)/2;
  ctx.clearRect(0,0,width,height);
  for(let f=0;f<6;f++) {
    const [nx,ny]=netPositions[f],sx=ox+nx*faceSize,sy=oy+ny*faceSize;
    if(game.collapsedFaces.has(f)){
      ctx.fillStyle='#090e18';ctx.fillRect(sx+1,sy+1,faceSize-2,faceSize-2);
      ctx.strokeStyle='#50313e';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(sx+6,sy+6);ctx.lineTo(sx+faceSize-6,sy+faceSize-6);ctx.moveTo(sx+faceSize-6,sy+6);ctx.lineTo(sx+6,sy+faceSize-6);ctx.stroke();continue;
    }
    ctx.fillStyle=f===game.players[0].face?'#253847':'#131e2c';ctx.fillRect(sx+1,sy+1,faceSize-2,faceSize-2);
    if(game.nextCollapse?.face===f&&game.nextCollapse.at-game.time<=FACE_COLLAPSE_WARNING){ctx.fillStyle=`rgba(255,65,87,${.2+.25*(.5+.5*Math.sin(game.time*Math.PI*5))})`;ctx.fillRect(sx+1,sy+1,faceSize-2,faceSize-2);}
    ctx.strokeStyle=f===game.players[0].face?`#${COLORS[0].toString(16)}`:'#304456';ctx.lineWidth=f===game.players[0].face?1.5:1;ctx.strokeRect(sx+1,sy+1,faceSize-2,faceSize-2);
    for(let y=0;y<8;y++)for(let x=0;x<8;x++) {
      const t=game.grid[f][y][x];if(!t)continue;ctx.fillStyle=t===1?'#46647c':'#f28a48';ctx.fillRect(sx+x*unit+1.2,sy+y*unit+1.2,unit-2,unit-2);
    }
  }
  const dot=(c,color,r=1)=>{const [nx,ny]=netPositions[c.face];ctx.fillStyle=color;ctx.fillRect(ox+(nx*8+c.x+.5)*unit-unit*r/2,oy+(ny*8+c.y+.5)*unit-unit*r/2,unit*r,unit*r);};
  for(const b of game.bombs){for(const c of game.blastCells(b))dot(c,'#ed715a66',.8);dot(bombExplosionCell(b,game.time),Math.sin(elapsed*12)>0?'#fff0b0':'#fb724c',.9);}
  for(const b of game.bonuses)dot(b,'#77e9ba',.55);
  for(const c of game.flames)dot(c,'#ffd977',1);
  for(const p of game.players)if(p.alive)dot(p,`#${COLORS[p.id].toString(16)}`,p.id===0?1.18:.9);
}
function beep(type,id=0){audio.event(type,characterOrder[id]??selectedCharacter);}
function soundUI(){
  $('sound').setAttribute('aria-label',soundEnabled?'Выключить звук':'Включить звук');$('sound').setAttribute('aria-pressed',String(soundEnabled));$('sound').classList.toggle('muted',!soundEnabled);
}
function syncMusic(){audio.setPlaying(!document.hidden&&(mode==='intro'||mode==='countdown'||mode==='playing'||mode==='dying'||mode==='finish'||(mode==='help'&&helpReturn==='intro')));}
async function unlockAudio(autoplay=false){
  if(!soundEnabled)return false;
  const ready=await audio.start({autoplay});syncMusic();soundUI();return ready;
}
soundUI();
function updateHud(force=false) {
  if(!force&&elapsed-lastHud<.12)return;lastHud=elapsed;
  const p=game.players[0],alive=game.players.filter(a=>a.alive).length;
  $('alive-count').textContent=`${alive} / 6`;
  $('range-value').textContent=p.range;$('bomb-value').textContent=`${game.bombs.filter(b=>b.owner===0).length} / ${p.capacity}`;
  $('speed-value').textContent=`×${(1+(p.speed-1)*.07).toFixed(2)}`;
  $('roster').innerHTML=game.players.map(a=>`<div class="roster-player${a.alive?'':' eliminated'}${a.id===0?' is-you':''}"><i style="--player-color:#${COLORS[a.id].toString(16)}"></i><span>${a.name}</span><small>${a.alive?(a.face===p.face?'ЗДЕСЬ':FACES[a.face].name):'ВЫБЫЛ'}</small></div>`).join('');
  drawMinimap();
}
function setMode(next) {
  mode=next;keys.clear();
  syncMusic();
  $('intro').classList.toggle('hidden',next!=='intro');$('hud').classList.toggle('hidden',next==='intro');
  $('pause-panel').classList.toggle('hidden',next!=='paused');$('finish-panel').classList.toggle('hidden',next!=='finish');$('help-panel').classList.toggle('hidden',next!=='help');
  $('countdown').classList.toggle('hidden',next!=='countdown');
  $('pause').classList.toggle('hidden',next==='intro'||next==='finish'||next==='dying');$('touch-controls').classList.toggle('hidden',next!=='playing');
  document.body.dataset.mode=next;resize();
}
function resetRound(){
  resetDeathAnimations();
  game.reset(Date.now());viewTurn=0;turnCamera(0,0,true);
  lastCollapseBeat=null;updateFaces();
  applyCharacters();
  for(const g of blocks.values())g.removeFromParent();blocks.clear();syncBlocks();
  for(const {mesh:m} of particles)m.removeFromParent();particles.length=0;
  nextVoice=7;
}
function start() {
  resetRound();
  countdownRemaining=3;lastCountdownNumber=3;$('countdown-number').textContent='3';
  setMode('countdown');unlockAudio().then(()=>{if(mode==='countdown')beep('countdown');});updateHud(true);$('world').focus();
}
function returnToMenu(){resetRound();setMode('intro');updateHud(true);document.querySelector(`[data-character="${selectedCharacter}"]`).focus();}
function pauseGame(){if(mode==='playing'||mode==='countdown'){pauseReturn=mode;setMode('paused');}}
function resumeGame(){setMode(pauseReturn);$('world').focus();}
function finish() {
  const won=game.status==='won';
  $('finish-title').textContent=won?'Победа!':'Вы проиграли';
  $('finish-description').textContent=won?'Ты пережил всех соперников. Куб твой!':`Место игрока: ${game.players[0].place}-е из 6.`;
  $('finish-stats').textContent=`Дальность ${game.players[0].range} · Бомб ${game.players[0].capacity}`;
  setMode('finish');
  if(won)beep('victory');
}
function handleEvents() {
  for(const event of game.events.splice(0)) {
    if((event.type==='move'||event.type==='collapse-return')&&event.id===0&&event.from.face!==event.to.face) {
      viewTurn=(viewTurn+event.dir-event.previousDir+4)%4;turnCamera(event.to.face,viewTurn);
    }
    if(event.type==='bomb'||event.type==='kick'||event.type==='bonus'||event.type==='death')beep(event.type,event.owner??event.id??0);
    if(event.type==='death'){beginDeath(event);burst(event.face,event.x,event.y,COLORS[event.id],20);}
    if(event.type==='explode') {beep('explode');flashTime=.5;if(event.face!==undefined)burst(event.face,event.x,event.y);syncBlocks();}
    if(event.type==='collapse'){
      beep('collapse');flashTime=1.4;
      for(let x=0;x<8;x+=2)for(const y of [0,7])burst(event.face,x,y,0xff6c55,8);
      for(let y=2;y<7;y+=2)for(const x of [0,7])burst(event.face,x,y,0xff6c55,8);
      syncBlocks();updateHud(true);
    }
  }
}
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
$('help').addEventListener('click',()=>{if(mode==='help'){setMode(helpReturn);return;}helpReturn=mode;setMode('help');});
$('close-help').addEventListener('click',()=>setMode(helpReturn));
const codeDirs={ArrowUp:0,KeyW:0,ArrowRight:1,KeyD:1,ArrowDown:2,KeyS:2,ArrowLeft:3,KeyA:3};
addEventListener('keydown',e=>{
  if(['Space','Enter'].includes(e.code)&&e.target.closest?.('button,a,input,select,textarea'))return;
  if(mode==='playing'&&['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
  if(e.repeat&&['Space','KeyQ','KeyE','Escape','KeyP','Enter'].includes(e.code))return;
  if(e.code==='Escape'||e.code==='KeyP') {if(mode==='paused')resumeGame();else if(mode==='help')setMode(helpReturn);else pauseGame();return;}
  if(e.code==='Enter'&&(mode==='intro'||mode==='finish')){start();return;}
  if(e.code==='KeyR'&&mode==='finish'){start();return;}
  if(mode!=='playing')return;
  if(e.code in codeDirs){keys.delete(e.code);keys.add(e.code);if(cameraTween>=1)game.move(0,(codeDirs[e.code]+viewTurn)%4);}
  if(e.code==='Space')game.placeBomb(0);
  if((e.code==='KeyQ'||e.code==='KeyE')&&cameraTween>=1){viewTurn=(viewTurn+(e.code==='KeyQ'?3:1))%4;turnCamera(game.players[0].face,viewTurn);}
});
addEventListener('keyup',e=>keys.delete(e.code));
addEventListener('blur',()=>{keys.clear();pauseGame();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseGame();syncMusic();});
for(const gesture of ['pointerdown','keydown'])document.addEventListener(gesture,e=>{
  if(!audio.isReady&&soundEnabled&&!e.target.closest?.('#sound'))unlockAudio();
},{capture:true});
for(const b of document.querySelectorAll('[data-dir]')) {
  b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);keys.clear();keys.add(`touch${b.dataset.dir}`);b.classList.add('pressed');if(mode==='playing'&&cameraTween>=1)game.move(0,(Number(b.dataset.dir)+viewTurn)%4);});
  const release=()=>{keys.delete(`touch${b.dataset.dir}`);b.classList.remove('pressed');};b.addEventListener('pointerup',release);b.addEventListener('pointercancel',release);b.addEventListener('lostpointercapture',release);
}
$('touch-bomb').addEventListener('pointerdown',e=>{e.preventDefault();if(mode==='playing')game.placeBomb(0);});
function moveInput() {
  if(cameraTween<1)return;
  const held=[...keys];const key=held[held.length-1];if(!key)return;
  const dir=key.startsWith('touch')?Number(key.slice(5)):codeDirs[key];
  if(dir!==undefined)game.move(0,(dir+viewTurn)%4);
}
applyCharacters();syncBlocks();updateHud(true);setMode('intro');unlockAudio(true);
let previous=performance.now();
function frame(now) {
  requestAnimationFrame(frame);const wallDt=(now-previous)/1000,dt=Math.min(wallDt,.05);previous=now;elapsed+=dt;
  if(mode==='countdown'){
    countdownRemaining=Math.max(0,countdownRemaining-wallDt);
    const number=Math.ceil(countdownRemaining);
    if(number!==lastCountdownNumber&&number>0){lastCountdownNumber=number;$('countdown-number').textContent=String(number);beep('countdown');}
    if(countdownRemaining<=0){setMode('playing');beep('start');}
  }
  if(mode==='playing'||mode==='dying'){
    game.update(dt);if(mode==='playing')moveInput();handleEvents();
    if(game.time>nextVoice){const candidates=game.players.filter(p=>p.alive);beep('voice',candidates[Math.floor(Math.random()*candidates.length)]?.id||0);nextVoice=game.time+7+Math.random()*5;}
    if(game.status==='lost'&&mode==='playing')setMode('dying');
    if(game.status==='won'||(mode==='dying'&&game.time-game.players[0].diedAt>=3))finish();
  }
  updateCamera(dt);updateFaces();updateCharacters();updateBombs();updateBonuses();updateHazards();updateParticles(dt);updateHud();renderer.render(scene,camera);
}
requestAnimationFrame(frame);
