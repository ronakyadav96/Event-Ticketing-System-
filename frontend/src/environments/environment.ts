export const environment = {
  production: false,
  // The Angular dev server proxies /api to the local backend. Keeping this
  // relative avoids browser CORS checks during local development.
  apiUrl: '',
  // FastAPI AI service (chat assistant)
  aiApiUrl: 'http://localhost:8000/api/v1',
  // apiUrl: 'https://event-ticketing-backend-1.onrender.com'
};
