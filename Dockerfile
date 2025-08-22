# Imagen base con Node y Python
FROM node:18-bullseye

# Instala Python 3.10 + dependencias
RUN apt-get update && apt-get install -y \
    python3.10 python3.10-venv python3.10-distutils \
    ffmpeg git curl && \
    rm -rf /var/lib/apt/lists/*

# Configura Python 3.10 como default
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.10 1

# Instala pip y venv
RUN curl -sS https://bootstrap.pypa.io/get-pip.py | python

# Instala Demucs y dependencias en Python
RUN pip install torch==2.4.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cpu
RUN pip install demucs==4.0.0 soundfile

# Crea directorio de la app
WORKDIR /app

# Copia los archivos del proyecto
COPY package*.json ./
RUN npm install
COPY . .

# Expone el puerto
EXPOSE 3000

# Comando de arranque
CMD ["node", "api.js"]
