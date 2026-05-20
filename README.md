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
<img width="1151" height="580" alt="image" src="https://github.com/user-attachments/assets/8ef8ddd6-5eb0-4623-91a3-1d2bf9a537d3" />

<img width="1160" height="678" alt="image" src="https://github.com/user-attachments/assets/077e706c-69e6-4f18-8ce5-3f7fbdafa495" />

<img width="1149" height="686" alt="image" src="https://github.com/user-attachments/assets/b045809c-c1f0-44f0-80c6-44f6976632b6" />


# DashFlex
- Painel web **open-source** para gerir Docker:
- Dashboard com atalhos, visão geral de métricas, containers, imagens e painel administrativo.
- Desenvolvido **100% em Python** (FastAPI + API Docker).
- Interface em **Português (BR)** e **English (US)**.

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
