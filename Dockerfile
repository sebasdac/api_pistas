# Imagen que ya trae Node.js + Python 3.10
FROM nikolaik/python-nodejs:python3.10-nodejs18

# Instala FFmpeg y utilidades necesarias
RUN apt-get update && apt-get install -y ffmpeg git curl && rm -rf /var/lib/apt/lists/*

# Actualiza pip y wheel
RUN pip install --upgrade pip wheel

# Instala dependencias de Python (IA de Demucs)
RUN pip install torch==2.4.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cpu
RUN pip install demucs==4.0.0 soundfile

# Crea directorio de la app
WORKDIR /app

# Copia e instala dependencias de Node
COPY package*.json ./
RUN npm install

# Copia el resto del proyecto
COPY . .

# Expone el puerto de tu API
EXPOSE 3000

# Arranca el servidor
CMD ["node", "api.js"]
