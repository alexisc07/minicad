import { transpile, createRuntime } from '../src/elec/arduino.js';
const progs = {
blink: `// Parpadeo
#define LED 13
void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}
void loop() {
  digitalWrite(LED, HIGH);
  delay(1000);
  digitalWrite(LED, LOW); delay(1000);
}`,
servo: `#include <Servo.h>
Servo myservo;  // objeto servo
int pos = 0;
void setup() { myservo.attach(9); }
void loop() {
  for (pos = 0; pos <= 180; pos += 1) { myservo.write(pos); delay(15); }
  for (int p = 180; p >= 0; p--) myservo.write(p);
}`,
mix: `const int pins[] = {2, 3, 4};
unsigned long previousMillis = 0;
const long interval = 500;
float temp = 0.0;
int readings[5];
String msg = "hola";
char c;
int lerFn(int a, int b = 2) { int r = a / b; return r; }
void setup() {
  Serial.begin(9600);
  for (int i = 0; i < sizeof(pins) / sizeof(pins[0]); i++) pinMode(pins[i], OUTPUT);
  int x = lerFn(7);
  Serial.println(x);
  Serial.println(7 / 2.0);
  Serial.println(255, HEX);
  Serial.println((int)3.7);
  temp = (float)analogRead(A0) * 5.0 / 1023;
  static int counter = 0;
  counter++;
  while (Serial.available() > 0) { c = Serial.read(); }
  if (msg.length() == 4) Serial.println("len ok");
  do { x--; } while (x > 0);
  Serial.print("fin x=");
  Serial.println(x);
}
void loop() {}`,
};
for (const [k, src] of Object.entries(progs)) {
  const r = transpile(src);
  console.log('==== ' + k + ' ====\n' + r.js + '\n-- hoisted: ' + r.hoisted);
}
// Ejecución real del programa "mix"
globalThis.MessageChannel ??= (await import('node:worker_threads')).MessageChannel;
let out = '';
const hw = { speed: () => 1, now: () => performance.now(), serialWrite: (s) => (out += s), pinMode() {}, digitalWrite() {}, digitalRead: () => 0, analogRead: () => 512, analogWrite() {}, servoAttach() {}, servoWrite() {}, tone() {}, noTone() {}, pulseIn: () => 0 };
const rt = createRuntime(progs.mix, hw);
setTimeout(() => rt.stop(), 300);
await rt.run((e) => console.log('ERROR', e.message, 'línea', e.line));
console.log('---- salida serie ----\n' + out);
// Error de sintaxis con línea
try { createRuntime('void setup() {\n  int x = ;\n}\nvoid loop(){}', hw); } catch (e) { console.log('sintaxis:', e.message, 'línea', e.line); }
// Error en tiempo de ejecución con línea
const rt2 = createRuntime('void setup() {\n\n  attachInterrupt(0, f, RISING);\n}\nvoid loop(){}', hw);
await rt2.run((e) => console.log('runtime:', e.message, 'línea', e.line));
process.exit(0);
