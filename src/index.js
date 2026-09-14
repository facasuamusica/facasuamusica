export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Endpoint não encontrado' }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};
