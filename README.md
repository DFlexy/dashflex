<div align="center">

# 💖 Apoie este projeto

**Este projeto é 100% independente e open-source.**  
💜 Seu apoio mantém o desenvolvimento ativo e faz o projeto continuar evoluindo.

**Observação:** o projeto foi todo criado em Python do zero.

<a href="https://donate.stripe.com/3cI3cvehCfd18bxbPoco000" target="_blank">
  <img src="https://img.shields.io/badge/💸%20APOIAR%20ESTE%20PROJETO-00C851?style=for-the-badge" width="500" />
</a>

</div>

---

# DashFlex

Repositório: [github.com/DFlexy/dashflex](https://github.com/DFlexy/dashflex)

Painel web **open-source** para gerir Docker: dashboard com atalhos, visão geral de métricas, containers, imagens e painel administrativo. Desenvolvido **100% em Python** (FastAPI + API Docker).
Interface em **Português (BR)** e **English (US)**.

## Requisitos

- Docker Engine (acesso ao socket `/var/run/docker.sock`)
- Porta **8787** (configurável)

## Imagem Docker (multi-plataforma)

Uma única imagem para **PC (amd64)** e **ARM (arm64)** — Raspberry Pi, servidores ARM, etc. 
O Docker baixa automaticamente a arquitetura correta:

```bash
docker pull ghcr.io/dflexy/dashflex:latest
```

### Executar

```bash
docker run -d \
  --name dashflex \
  -p 8787:8787 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v dashflex_data:/app/data \
  --restart unless-stopped \
  ghcr.io/dflexy/dashflex:latest
```

Abra [http://localhost:8787](http://localhost:8787).

### Docker Compose

```bash
docker compose up -d
```

## Licença

Open-source — consulte o repositório para termos de uso.
