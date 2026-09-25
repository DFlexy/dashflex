# DashFlex

Painel web open-source para gerir Docker. Feito em Python (FastAPI + API Docker), com interface em **Português (Brasil)** e **English (US)**.

- **Dashboard** com atalhos dos containers (abrir, editar, logs) e tamanho dos cartões ajustável
- **Visão geral** de CPU, memória, rede e do host
- **Containers** e **imagens** locais, com ações no daemon
- **Administrativo** para URL do Docker, limpeza, nome do app e idioma
- **Tema** SciFi (escuro) ou Paper (claro), cor primária e padrões de fundo

<img width="1151" height="580" alt="Dashboard do DashFlex" src="https://github.com/user-attachments/assets/8ef8ddd6-5eb0-4623-91a3-1d2bf9a537d3" />

<img width="1160" height="678" alt="Visão geral do DashFlex" src="https://github.com/user-attachments/assets/077e706c-69e6-4f18-8ce5-3f7fbdafa495" />

<img width="1149" height="686" alt="Painel administrativo do DashFlex" src="https://github.com/user-attachments/assets/b045809c-c1f0-44f0-80c6-44f6976632b6" />

## Requisitos

- Docker Engine com acesso ao socket `/var/run/docker.sock`
- Porta **8787** (configurável com a variável `PORT`)

## Executar

A imagem publicada cobre **amd64** e **arm64** (PC e Raspberry Pi). O Docker escolhe a arquitetura.

```bash
docker pull ghcr.io/dflexy/dashflex:latest

docker run -d \
  --name dashflex \
  -p 8787:8787 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v dashflex_data:/app/data \
  --restart unless-stopped \
  ghcr.io/dflexy/dashflex:latest
```

Abra [http://localhost:8787](http://localhost:8787).

Configurações, atalhos e o tema ficam no volume `dashflex_data`.

## Compilar a partir do código

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

## Apoie este projeto

O DashFlex é independente e open-source. O apoio mantém o desenvolvimento ativo.

<a href="https://donate.stripe.com/3cI3cvehCfd18bxbPoco000" target="_blank">
  <img src="https://img.shields.io/badge/💸%20APOIAR%20ESTE%20PROJETO-00C851?style=for-the-badge" width="500" alt="Apoiar este projeto" />
</a>

## Licença

Open-source. Consulte o repositório para os termos de uso.
