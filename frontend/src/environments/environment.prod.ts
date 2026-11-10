export const environment = {
  production: true,
  apiUrl: 'https://event-ticketing-backend.vercel.app',
  // FastAPI AI service (chat assistant). Set this to the deployed ai-service URL,
  // e.g. 'https://<your-ai-service>.onrender.com/api/v1'. While empty, the chat widget is hidden.
  aiApiUrl: 'https://event-ticketing-ai.vercel.app/api/v1',
};
