import json
import base64
import requests

# 1. Configuración de credenciales (Extraído de tu panel)
# REEMPLAZA 'TU_TOKEN_COMPLETO_AQUÍ' por el token generado en LabsMobile
USUARIO = "sms@2ways.us"
API_TOKEN = "Fsm8fvbNyj0WOFu8s05VusMYNUPegyAL" 

# La API de LabsMobile requiere codificar usuario:token en formato Base64
credenciales_raw = f"{USUARIO}:{API_TOKEN}"
credenciales_b64 = base64.b64encode(credenciales_raw.encode()).decode()

# 2. Configuración del mensaje y endpoint
url = "https://api.labsmobile.com/json/send"

payload = json.dumps({
    "message": "Hola, esta es una prueba de envío exitosa desde Python.",
    "tpoa": "Prueba", # Remitente: Texto de hasta 11 caracteres o número validado
    "recipient": [
        {
            "msisdn": "573136417275" # Reemplaza con el número destino (Código de país + número)
        }
    ]
})

headers = {
    'Content-Type': 'application/json',
    'Authorization': f'Basic {credenciales_b64}',
    'Cache-Control': 'no-cache'
}

# 3. Ejecución de la petición HTTP POST
try:
    print("Enviando SMS de prueba...")
    response = requests.post(url, headers=headers, data=payload)
    
    print(f"Código de estado HTTP: {response.status_code}")
    print("Respuesta de LabsMobile:")
    print(json.dumps(response.json(), indent=4))

except Exception as e:
    print(f"Ocurrió un error en la conexión: {e}")
