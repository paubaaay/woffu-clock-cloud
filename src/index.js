export default {
  async fetch(request, env) {
    return new Response("Woffu Clock Cloud funcionando ✅");
  },

  async scheduled(controller, env, ctx) {
    console.log("Cron ejecutado");
  },
};
