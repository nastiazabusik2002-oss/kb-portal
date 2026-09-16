FROM python:3.11-slim
WORKDIR /app
COPY index.html index.html
EXPOSE 8080
CMD ["python3", "-m", "http.server", "8080"]
