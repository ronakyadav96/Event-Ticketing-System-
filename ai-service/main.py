"""ASGI entry point: `uvicorn main:app --port 8000` from the ai-service directory."""

from app.main import app

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
