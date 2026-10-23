FROM python:3.14.9-slim-trixie@sha256:b347e2dcbc7f0b6f9fb7182e9da6a187fb10ae715e0692518c1aed0eec94a700
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY employee_read_gateway ./employee_read_gateway
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["python", "-m", "employee_read_gateway"]
CMD ["serve", "--config", "/config/gateway.json"]
