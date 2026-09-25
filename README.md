# DashFlex

Painel web open-source para gerir Docker. Feito em Python (FastAPI + API Docker)
Com interface em **Português (Brasil)** e **English (US)**.

- **Dashboard** com atalhos dos containers (abrir, editar, logs) e tamanho dos cartões ajustável
- **Visão geral** de CPU, memória, rede e do host
- **Containers** e **imagens** locais, com ações no daemon
- **Administrativo** para URL do Docker, limpeza, nome do app e idioma
- **Tema** SciFi (escuro) ou Paper (claro), cor primária e padrões de fundo

<img width="1264" height="901" alt="image" src="https://github.com/user-attachments/assets/8031a1fc-1285-4473-8479-0b006d089a49" />

<img width="1280" height="927" alt="image" src="https://github.com/user-attachments/assets/f625ed48-229b-4037-a961-5f290e095952" />

<img width="1263" height="893" alt="image" src="https://github.com/user-attachments/assets/79eff659-0fe0-466c-836c-3502baf047ac" />



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
