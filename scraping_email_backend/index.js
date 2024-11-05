require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const winston = require('winston');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuração de logs com Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/application.log' })
    ]
});

// Cache para notícias e configurações de usuário
const cache = { date: null, news: [] };
let userConfig = { hour: 8, numberOfArticles: 5 };

// Função de scraping da Folha de S.Paulo
async function scrapeWebsite() {
    const url = 'https://www.folha.uol.com.br/';
    try {
        logger.info(`Iniciando scraping na URL: ${url}`);
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        
        const $ = cheerio.load(data);
        const articles = [];

        // Fazendo o scraping dos títulos das notícias
        $('a.c-headline__url').each((i, element) => {
            const title = $(element).text().trim();
            const link = $(element).attr('href');
            const fullLink = link.startsWith('http') ? link : `https://www.folha.uol.com.br${link}`;
            articles.push({ title, link: fullLink });
        });

        logger.info("Scraping realizado com sucesso.");
        return articles.slice(0, userConfig.numberOfArticles); // Retorna o número de artigos configurado
    } catch (error) {
        logger.error(`Erro no scraping: ${error.response ? error.response.status : error.message}`);
        return [];
    }
}

// Função de envio de email
async function sendEmail(scrapedData) {
    const transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    const emailContent = scrapedData.map(item => `${item.title} - ${item.link}`).join('\n');

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: 'Últimas notícias da Folha de S.Paulo',
        text: emailContent
    };

    try {
        await transporter.sendMail(mailOptions);
        logger.info('Email enviado com sucesso!');
    } catch (error) {
        logger.error(`Erro ao enviar email: ${error.message}`);
    }
}

// Endpoint para configurar preferências do usuário
app.post('/config', (req, res) => {
    const { hour, numberOfArticles } = req.body;
    if (hour >= 0 && hour <= 23) userConfig.hour = hour; // Valida o horário entre 0 e 23 horas
    if (numberOfArticles > 0) userConfig.numberOfArticles = numberOfArticles; // Valida que o número de artigos seja positivo

    logger.info(`Configurações atualizadas: ${JSON.stringify(userConfig)}`);
    res.send({ message: 'Configurações atualizadas com sucesso' });
});

// Endpoint para obter configurações atuais
app.get('/config', (req, res) => {
    res.send(userConfig);
});

// Função para obter notícias do cache ou fazer scraping
async function getCachedNews() {
    const today = new Date().toISOString().split('T')[0];
    if (cache.date === today) {
        logger.info("Usando cache de notícias");
        return cache.news;
    }
    const news = await scrapeWebsite();
    cache.date = today;
    cache.news = news;
    return news;
}

// Limite de requisições para evitar abuso
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: 'Muitas requisições! Por favor, tente novamente mais tarde.'
});

app.use('/scrape-and-email', limiter);

// Endpoint para realizar o scraping e enviar o email manualmente
app.get('/scrape-and-email', async (req, res) => {
    const scrapedData = await getCachedNews();
    if (scrapedData.length === 0) {
        logger.error('Erro no scraping, sem dados retornados.');
        return res.status(500).send({ message: 'Erro no scraping' });
    }

    await sendEmail(scrapedData);
    res.send({ message: 'Scraping e envio de email concluídos' });
});

// Agendamento diário com base nas configurações do usuário
cron.schedule(`0 ${userConfig.hour} * * *`, async () => {
    logger.info(`Executando scraping e envio de e-mail agendado às ${userConfig.hour}h.`);
    const scrapedData = await getCachedNews();
    if (scrapedData.length > 0) {
        await sendEmail(scrapedData);
    } else {
        logger.error('Erro no scraping durante execução agendada, sem dados retornados.');
    }
});

app.listen(PORT, () => {
    logger.info(`Servidor rodando na porta ${PORT}`);
});
