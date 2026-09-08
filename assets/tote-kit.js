/* Beehive Bin Co. — shared Three.js scene helpers.
   Classic script (no imports) so pages work over file:// and http alike.
   Pages import THREE + loaders as ES modules, then call:
     const kit = await ToteKit(THREE, GLTFLoader, DRACOLoader);
*/
window.ToteKit = async function (THREE, GLTFLoader, DRACOLoader) {
  // Decode the embedded GLB once per page.
  const raw = Uint8Array.from(atob(window.TOTE_GLB_BASE64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([raw], { type: 'model/gltf-binary' }));
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
  const source = gltf.scene;

  function shadowize(o) {
    o.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
  }
  shadowize(source);

  const rawBox = new THREE.Box3().setFromObject(source);
  const rawSize = new THREE.Vector3(); rawBox.getSize(rawSize);
  const rawCenter = new THREE.Vector3(); rawBox.getCenter(rawCenter);
  const baseScale = 0.90 / Math.max(rawSize.x, rawSize.z);


  // Brand print: the stacked logo as a one-ink yellow "screen print" on both
  // long sides of every tote. Drawn from the logo SVG outlines into a canvas
  // at runtime (Path2D), so it stays file://-safe and needs no image asset.
  const PRINT_ICON = 'M16 1.5 29 9v14L16 30.5 3 23V9z M9 10.6H23V13.2H21.47L20.3 21.5H11.7L10.53 13.2H9Z';
  const PRINT_LINE1 = 'M722 519Q722 392 607 359V355Q738 325 738 183Q738 129 711.5 87.5Q685 46 639.0 23.0Q593 0 538 0H74V688H532Q584 688 627.5 666.5Q671 645 696.5 606.0Q722 567 722 519ZM295 420H447Q469 420 483.5 435.5Q498 451 498 474V484Q498 506 483.0 521.5Q468 537 447 537H295ZM295 160H463Q485 160 499.5 175.5Q514 191 514 214V224Q514 247 499.5 262.5Q485 278 463 278H295Z M852 688H1447V523H1073V428H1393V270H1073V165H1454V0H852Z M1574 688H2169V523H1795V428H2115V270H1795V165H2176V0H1574Z M2760 0V261H2517V0H2296V688H2517V437H2760V688H2981V0Z M3139 0V688H3360V0Z M3705 0 3461 688H3697L3835 228H3839L3978 688H4204L3961 0Z M4296 688H4891V523H4517V428H4837V270H4517V165H4898V0H4296Z';
  const PRINT_LINE2 = 'M722 519Q722 392 607 359V355Q738 325 738 183Q738 129 711.5 87.5Q685 46 639.0 23.0Q593 0 538 0H74V688H532Q584 688 627.5 666.5Q671 645 696.5 606.0Q722 567 722 519ZM295 420H447Q469 420 483.5 435.5Q498 451 498 474V484Q498 506 483.0 521.5Q468 537 447 537H295ZM295 160H463Q485 160 499.5 175.5Q514 191 514 214V224Q514 247 499.5 262.5Q485 278 463 278H295Z M862 0V688H1083V0Z M1733 0 1444 334V0H1241V688H1434L1723 349V688H1926V0Z M3066 405H2855Q2855 465 2823.5 500.0Q2792 535 2734 535Q2667 535 2635.5 493.0Q2604 451 2604 376V312Q2604 238 2635.5 195.5Q2667 153 2732 153Q2796 153 2829.0 186.0Q2862 219 2862 279H3066Q3066 138 2979.5 63.0Q2893 -12 2735 -12Q2559 -12 2468.5 78.0Q2378 168 2378 344Q2378 520 2468.5 610.0Q2559 700 2735 700Q2888 700 2977.0 623.5Q3066 547 3066 405Z M3899 344Q3899 170 3802.0 79.0Q3705 -12 3527 -12Q3349 -12 3252.5 78.5Q3156 169 3156 344Q3156 519 3252.5 609.5Q3349 700 3527 700Q3705 700 3802.0 609.0Q3899 518 3899 344ZM3382 376V312Q3382 239 3419.0 196.0Q3456 153 3527 153Q3598 153 3635.5 196.0Q3673 239 3673 312V376Q3673 449 3635.5 492.0Q3598 535 3527 535Q3456 535 3419.0 492.0Q3382 449 3382 376Z';
  const PRINT_PERIOD = 'M457.40,322.60L466.81,328.03L466.81,338.17L457.40,343.60L447.99,338.17L447.99,328.03Z';
  let printMaterial = null;
  function getPrintMaterial() {
    if (printMaterial) return printMaterial;
    const W = 720, H = Math.round(720 * 355 / 514), k = W / 514;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#FFC400';
    g.setTransform(k, 0, 0, k, 0, 0);
    g.translate(182.2, 10); g.scale(4.6875, 4.6875);
    g.fill(new Path2D(PRINT_ICON), 'evenodd');
    g.setTransform(k, 0, 0, k, 0, 0);
    g.translate(10.00, 258.8); g.scale(0.1, -0.1);
    g.fill(new Path2D(PRINT_LINE1));
    g.setTransform(k, 0, 0, k, 0, 0);
    g.translate(47.59, 343.6); g.scale(0.1, -0.1);
    g.fill(new Path2D(PRINT_LINE2));
    g.setTransform(k, 0, 0, k, 0, 0);
    g.fill(new Path2D(PRINT_PERIOD));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    printMaterial = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, alphaTest: 0.15,
      roughness: 0.85, metalness: 0,
      emissive: 0xFFC400, emissiveMap: tex, emissiveIntensity: 0.35
    });
    return printMaterial;
  }
  // Placement measured off the mesh: the flat center of each long side sits at
  // z = 0.207 (at y = 0.165) with a ~5.8-degree outward draft; the decal floats
  // 4mm off the surface and tilts to match.
  const printGeo = [];
  function addPrint(t) {
    if (!printGeo.length) printGeo.push(new THREE.PlaneGeometry(0.15, 0.15 * 355 / 514));
    for (const back of [false, true]) {
      const p = new THREE.Mesh(printGeo[0], getPrintMaterial());
      p.name = 'brand-print';
      p.position.set(0, 0.165, (back ? -1 : 1) * 0.211);
      // Euler XYZ applies the Y flip before X, so the back plane's outward
      // tilt needs the opposite X sign to lean with the wall, not into it.
      p.rotation.set(back ? -0.101 : 0.101, back ? Math.PI : 0, 0);
      p.castShadow = false; p.receiveShadow = false;
      t.add(p);
    }
  }

  function makeTote(scale = 1) {
    const t = source.clone(true);
    t.position.sub(rawCenter);
    t.scale.setScalar(scale);
    shadowize(t);
    addPrint(t);
    return t;
  }

  function findLid(tote) {
    let lid = tote.getObjectByName('P03008883_Storage Tote_top')
           || tote.getObjectByName('P03008883_Storage Tote_Top');
    if (!lid) lid = tote.children.find(n => (n.name || '').toLowerCase().includes('top'));
    return lid || null;
  }

  function makeRenderer(canvas, dark = false) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    // Linear tone mapping keeps the lid's brand yellow true on screen —
    // filmic curves (ACES etc.) desaturate bright surfaces toward cream.
    r.toneMapping = THREE.LinearToneMapping;
    r.toneMappingExposure = dark ? 1.15 : 1.04;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    return r;
  }

  function addLights(scene, dark = false) {
    scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x222222 : 0xb8b8b0, dark ? 1.6 : 2.4));
    const key = new THREE.DirectionalLight(0xffffff, dark ? 4.4 : 3.6);
    // Almost straight overhead, tilted a touch toward the camera: the cast
    // shadow sits directly beneath each bin and falls slightly BEHIND it —
    // never out front, never detached.
    key.position.set(0.2, 8, 1.4); key.castShadow = true;
    // Bias settings prevent self-shadowing "wiggle" stripes on the tote surfaces.
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.03;
    scene.add(key);
    const fill = new THREE.DirectionalLight(dark ? 0xf4f4ff : 0xffffff, dark ? 2.1 : 1.4);
    fill.position.set(-3, 1.8, 2.2); scene.add(fill);
    const rim = new THREE.DirectionalLight(dark ? 0xffe7a0 : 0xffffff, dark ? 1.6 : 0.9);
    rim.position.set(0, 2, -3); scene.add(rim);
  }

  function addFloor(scene, y = -0.38, dark = false) {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 96),
      new THREE.ShadowMaterial({ opacity: dark ? 0.26 : 0.16 })
    );
    floor.rotation.x = -Math.PI / 2; floor.position.y = y; floor.receiveShadow = true;
    scene.add(floor);
  }

  // Fake contact shadow: a soft dark ellipse pinned under a bin's footprint.
  // Unlike cast shadows it can never detach, offset, or smear — it IS the
  // grounding, by construction.
  let blobTexture = null;
  function addBlob(parent, {x = 0, z = 0, y = 0, w = 1, d = 1, opacity = .3} = {}) {
    if (!blobTexture) {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
      grad.addColorStop(0, 'rgba(0,0,0,.9)');
      grad.addColorStop(.55, 'rgba(0,0,0,.45)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
      blobTexture = new THREE.CanvasTexture(c);
    }
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({map: blobTexture, transparent: true, opacity, depthWrite: false})
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.renderOrder = -1;
    parent.add(m);
    return m;
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  // 0 → 1 as a tall section scrolls under its sticky child.
  function progressFor(sec) {
    const rect = sec.getBoundingClientRect();
    const total = sec.offsetHeight - innerHeight;
    return total > 0 ? clamp(-rect.top / total, 0, 1) : 0;
  }

  const views = []; // {renderer, camera, canvas, scene, update}
  function register(view) { views.push(view); return view; }

  function resize() {
    for (const v of views) {
      const w = v.canvas.clientWidth, h = v.canvas.clientHeight;
      if (!w || !h) continue;
      v.renderer.setSize(w, h, false);
      v.camera.aspect = w / h;
      v.camera.updateProjectionMatrix();
    }
  }

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function start() {
    addEventListener('resize', resize);
    resize();
    function loop(t) {
      requestAnimationFrame(loop);
      for (const v of views) {
        if (v.update) v.update(t);
        v.renderer.render(v.scene, v.camera);
      }
    }
    requestAnimationFrame(loop);
  }

  const api = {
    THREE, source, rawSize, rawCenter, baseScale,
    makeTote, findLid, makeRenderer, addLights, addFloor, addBlob,
    clamp, ease, progressFor, register, resize, start, reducedMotion
  };
  window.__toteKit = api; // handy for debugging in devtools
  return api;
};
