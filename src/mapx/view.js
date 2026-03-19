/**
 * Custom code view handler — Zartigl surface wind particles
 * Uses: https://cdn.jsdelivr.net/npm/@fxi/zartigl@0.1.4/dist/zartigl.js
 */
function handler() {
  return {
    onClose: async function (cc) {
      await cc._clean_local();
    },

    onInit: async function (cc) {
      cc._clean_local = cleanLocal;

      cc.setLegend("<span>Loading surface wind…</span>");

      /**
       * Import zartigl as ESM from jsDelivr CDN
       */
      const { ParticleLayer } = await import(
        "https://cdn.jsdelivr.net/npm/@fxi/zartigl@0.1.4/dist/zartigl.js"
      );

      if (cc.isClosed()) return;

      /**
       * Dataset: CMEMS Global Sea Surface Wind L4 NRT
       * Product: WIND_GLO_PHY_L4_NRT_012_004
       * Variables: eastward_wind, northward_wind — unit: m s⁻¹
       * Time: 1 h steps, starting 2023-11-20
       */
      const ZARR_URL =
        "https://s3.waw3-1.cloudferro.com/mdl-arco-time-050/arco/" +
        "WIND_GLO_PHY_L4_NRT_012_004/" +
        "cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H_202207/timeChunked.zarr";

      const LAYER_ID = cc.idView;

      const layer = new ParticleLayer({
        id: LAYER_ID,
        source: ZARR_URL,
        variableU: "eastward_wind",
        variableV: "northward_wind",
        time: 1700438400000, // 2023-11-20 00:00 UTC
        particleDensity: 0.004,
        speedFactor: [0.01, 0.07],
        fadeOpacity: [0.9174, 0.9793],
        dropRate: 0.005,
        opacity: 0.9,
        logScale: true,
        vibrance: 1,
      });

      cc.map.addLayer(layer, "mxlayers");
      layer.setRenderMode("particles");

      cc.setLegend(`
          <div style="font-family:sans-serif;padding:6px 10px;font-size:12px">
            <b>Surface Wind</b><br>
            <small style="color:#aaa">CMEMS · Global · 1 h steps</small>
            <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
              <span>slow</span>
              <div style="flex:1;height:8px;border-radius:4px;
                background:linear-gradient(to right,#3288bd,#66c2a5,#abdda4,
                  #e6f598,#fee08b,#fdae61,#f46d43,#d53e4f)">
              </div>
              <span>fast</span>
            </div>
          </div>
        `);

      function cleanLocal() {
        try {
          if (cc.map.getLayer(LAYER_ID)) {
            cc.map.removeLayer(LAYER_ID);
          }
        } catch (e) {
          console.warn("zartigl cleanLocal:", e);
        }
      }
    },
  };
}
