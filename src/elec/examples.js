// Proyectos de ejemplo: circuito, piezas mecánicas y programa listos para simular.

const ARD = [0, 0, 0];

export const BLANK_CODE = `// Programa para Arduino UNO
// setup() se ejecuta una vez al empezar; loop() se repite sin parar.

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("Hola desde MiniCAD");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;

// LED con resistencia en serie conectado a un pin
function ledOn(api, ard, pin, x, color = 'rojo') {
  const r = api.add('resistor', { r: 220 }, [x, 0, -50], [0, 90, 0]);
  const led = api.add('led', { color }, [x - 1.27, 0, -78]);
  api.wire(ard, pin, r, '1');
  api.wire(r, '2', led, 'A');
  api.wire(led, 'K', ard, 'GND3');
  return led;
}

function servoWithArm(api, ard) {
  const servo = api.add('servo', {}, [0, 0, -95]);
  api.wire(servo, 'GND', ard, 'GND3');
  api.wire(servo, 'VCC', ard, '5V');
  api.wire(servo, 'SIG', ard, 'D9');
  const arm = api.body('box', { w: 55, h: 4, d: 8 }, [5.9 + 24, 29.5 + 1.6 + 2, -95], 'Brazo', '#e0a526');
  api.mount(arm, servo);
  return servo;
}

export const EXAMPLES = [
  {
    id: 'blink',
    label: 'Parpadeo de un LED',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      ledOn(api, ard, 'D13', -5.34);
    },
    code: `// Parpadeo: enciende y apaga un LED cada medio segundo.
// LED + resistencia de 220 Ω en el pin 13.
const int LED = 13;

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, HIGH);  // enciende
  delay(500);
  digitalWrite(LED, LOW);   // apaga
  delay(500);
}
`,
  },
  {
    id: 'semaforo',
    label: 'Semáforo',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      ledOn(api, ard, 'D12', -20, 'rojo');
      ledOn(api, ard, 'D11', 0, 'amarillo');
      ledOn(api, ard, 'D10', 20, 'verde');
    },
    code: `// Semáforo con tres LEDs (rojo, amarillo y verde).
const int ROJO = 12;
const int AMARILLO = 11;
const int VERDE = 10;

void setup() {
  pinMode(ROJO, OUTPUT);
  pinMode(AMARILLO, OUTPUT);
  pinMode(VERDE, OUTPUT);
  Serial.begin(9600);
}

void encender(int pin, int ms) {
  digitalWrite(pin, HIGH);
  delay(ms);
  digitalWrite(pin, LOW);
}

void loop() {
  Serial.println("Verde");
  encender(VERDE, 3000);
  Serial.println("Amarillo");
  for (int i = 0; i < 3; i++) {   // parpadeo
    encender(AMARILLO, 300);
    delay(300);
  }
  Serial.println("Rojo");
  encender(ROJO, 3000);
}
`,
  },
  {
    id: 'boton',
    label: 'Botón que enciende un LED',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      ledOn(api, ard, 'D13', -5.34, 'verde');
      const btn = api.add('button', {}, [25, 0, -55]);
      api.wire(ard, 'D2', btn, '1');
      api.wire(btn, '2', ard, 'GND3');
    },
    code: `// Al mantener pulsado el botón se enciende el LED.
// El botón usa la resistencia interna (INPUT_PULLUP):
// sin pulsar lee HIGH y pulsado lee LOW.
const int BOTON = 2;
const int LED = 13;

void setup() {
  pinMode(BOTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  if (digitalRead(BOTON) == LOW) {
    digitalWrite(LED, HIGH);
  } else {
    digitalWrite(LED, LOW);
  }
  delay(10);
}
`,
  },
  {
    id: 'protoboard',
    label: 'Protoboard: botón y LED',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      const bb = api.add('breadboard', {}, [0, 0, -95]);
      const col = (c) => (c - 15.5) * 2.54;
      // Resistencia entre las columnas 6 y 10 (fila c); LED entre la 9 (−) y la 10 (+)
      api.add('resistor', { r: 220 }, [col(8), 8.5, -95 + 8.89]);
      api.add('led', { color: 'rojo' }, [col(9.5), 8.5, -95 + 13.97]);
      // Pulsador entre las columnas 20 y 23 (fila d)
      api.add('button', {}, [col(21.5), 8.5, -95 + 6.35]);
      api.wire(ard, 'D13', bb, '6e');
      api.wire(bb, '9b', bb, 'b-7');
      api.wire(ard, 'D2', bb, '20a');
      api.wire(bb, '23a', bb, 'b-19');
      api.wire(ard, 'GND3', bb, 'b-3');
    },
    code: `// Montaje en protoboard: las patas de los componentes se conectan
// solas a los agujeros. Cada columna de 5 agujeros está unida por dentro
// y la fila azul (−) de abajo es la tierra (GND).
// Pulsa el botón durante la simulación para encender el LED.
const int BOTON = 2;
const int LED = 13;

void setup() {
  pinMode(BOTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, digitalRead(BOTON) == LOW ? HIGH : LOW);
  delay(10);
}
`,
  },
  {
    id: 'servo',
    label: 'Servo con brazo (barrido)',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      servoWithArm(api, ard);
    },
    code: `// Barrido: el servo gira de 0° a 180° y vuelve.
// La pieza "Brazo" está acoplada al servo y se mueve con él.
#include <Servo.h>

Servo miServo;

void setup() {
  miServo.attach(9);
}

void loop() {
  for (int angulo = 0; angulo <= 180; angulo += 2) {
    miServo.write(angulo);
    delay(15);
  }
  for (int angulo = 180; angulo >= 0; angulo -= 2) {
    miServo.write(angulo);
    delay(15);
  }
}
`,
  },
  {
    id: 'potservo',
    label: 'Potenciómetro controla un servo',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      servoWithArm(api, ard);
      const pot = api.add('pot', { r: 10000 }, [14, 0, 55]);
      api.wire(pot, '1', ard, 'GND');
      api.wire(pot, 'W', ard, 'A0');
      api.wire(pot, '2', ard, '5V');
    },
    code: `// Gira el potenciómetro (arrástralo durante la simulación)
// y el servo copia su posición.
#include <Servo.h>

Servo miServo;

void setup() {
  miServo.attach(9);
  Serial.begin(9600);
}

void loop() {
  int lectura = analogRead(A0);              // 0 a 1023
  int angulo = map(lectura, 0, 1023, 0, 180);
  miServo.write(angulo);
  Serial.print("Lectura: ");
  Serial.print(lectura);
  Serial.print("  Ángulo: ");
  Serial.println(angulo);
  delay(50);
}
`,
  },
  {
    id: 'ultrasonido',
    label: 'Sensor de distancia (ultrasonido)',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      const us = api.add('ultrasonic', {}, [0, 0, -70], [0, 180, 0]);
      api.wire(us, 'VCC', ard, '5V');
      api.wire(us, 'TRIG', ard, 'D9');
      api.wire(us, 'ECHO', ard, 'D10');
      api.wire(us, 'GND', ard, 'GND3');
      api.body('box', { w: 100, h: 60, d: 10 }, [0, 30, -230], 'Obstáculo', '#d79c9c');
    },
    code: `// Mide la distancia al obstáculo. Mueve la pieza "Obstáculo"
// durante la simulación y mira el Monitor serie.
// El LED de la placa (L) se enciende si está a menos de 15 cm.
const int TRIG = 9;
const int ECHO = 10;

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);

  long duracion = pulseIn(ECHO, HIGH);
  float distancia = duracion / 58.0;   // en centímetros

  Serial.print("Distancia: ");
  Serial.print(distancia);
  Serial.println(" cm");

  digitalWrite(LED_BUILTIN, distancia < 15 ? HIGH : LOW);
  delay(200);
}
`,
  },
  {
    id: 'motor',
    label: 'Motor DC con transistor',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      const r = api.add('resistor', { r: 1000 }, [25, 0, -38], [0, 90, 0]);
      const q = api.add('npn', { model: 'TIP120' }, [30, 0, -60]);
      const motor = api.add('motor', { vn: 9, rpm: 120 }, [85, 15, -60]);
      const d = api.add('diode', {}, [60, 0, -88]);
      const bat = api.add('battery', { v: 9 }, [80, 0, 30]);
      api.wire(ard, 'D3', r, '1');
      api.wire(r, '2', q, 'B');
      api.wire(q, 'E', ard, 'GND3');
      api.wire(bat, '+', motor, '+');
      api.wire(motor, '-', q, 'C');
      api.wire(d, 'A', motor, '-');
      api.wire(d, 'K', motor, '+');
      api.wire(bat, '-', ard, 'GND2');
      const wheel = api.body('prism', { r: 22, n: 5, h: 6 }, [85 + 14.5 + 8, 15 + 10, -60], 'Rueda', '#2fb35a', [0, 0, 90]);
      api.mount(wheel, motor);
    },
    code: `// Controla la velocidad de un motor con PWM y un transistor TIP120.
// El motor se alimenta con la batería de 9 V; el Arduino sólo
// activa la base del transistor a través de una resistencia de 1 kΩ.
const int MOTOR = 3;   // pin PWM (~)

void setup() {
  pinMode(MOTOR, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  for (int v = 0; v <= 255; v += 5) {   // acelera
    analogWrite(MOTOR, v);
    delay(40);
  }
  Serial.println("Velocidad máxima");
  delay(1500);
  for (int v = 255; v >= 0; v -= 5) {   // frena
    analogWrite(MOTOR, v);
    delay(40);
  }
  Serial.println("Parado");
  delay(1500);
}
`,
  },
  {
    id: 'luz',
    label: 'Luz nocturna (sensor de luz)',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      ledOn(api, ard, 'D9', 4.82, 'blanco');
      const ldr = api.add('ldr', {}, [12, 0, 55]);
      const r = api.add('resistor', { r: 10000 }, [25, 0, 50], [0, 90, 0]);
      api.wire(ldr, '1', ard, '5V');
      api.wire(ldr, '2', ard, 'A0');
      api.wire(r, '1', ard, 'A0');
      api.wire(r, '2', ard, 'GND');
    },
    code: `// Cuanto más oscuro, más brilla el LED.
// La fotorresistencia y una resistencia de 10 kΩ forman un divisor
// de tensión en A0. Cambia la luz en el panel de propiedades del LDR.
const int LED = 9;   // pin PWM

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int luz = analogRead(A0);
  int brillo = map(luz, 0, 1023, 255, 0);
  brillo = constrain(brillo, 0, 255);
  analogWrite(LED, brillo);
  Serial.print("Luz: ");
  Serial.println(luz);
  delay(100);
}
`,
  },
  {
    id: 'melodia',
    label: 'Melodía con zumbador',
    build(api) {
      const ard = api.add('arduino', {}, ARD);
      const bz = api.add('buzzer', { kind: 'pasivo' }, [20, 0, -55]);
      api.wire(ard, 'D8', bz, '+');
      api.wire(bz, '-', ard, 'GND3');
    },
    code: `// Toca una escala con un zumbador pasivo usando tone().
int notas[] = {262, 294, 330, 349, 392, 440, 494, 523};

void setup() {
}

void loop() {
  for (int i = 0; i < 8; i++) {
    tone(8, notas[i], 250);
    delay(300);
  }
  noTone(8);
  delay(1000);
}
`,
  },
];
