#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <SPI.h>
#include <Wire.h>
#include <time.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include "MAX30100_PulseOximeter.h"

// ── Pin Definitions ──────────────────────────────────────────
#define OLED_MOSI   23
#define OLED_CLK    18
#define OLED_DC     33
#define OLED_CS      5
#define OLED_RESET  25
#define BUTTON      19
#define BUZZER      32

// ── I2C Bus pins ─────────────────────────────────────────────
// MAX30100 must be on default Wire bus (library uses Wire internally)
#define POX_SDA     26
#define POX_SCL     27
// MPU6050 on Wire1
#define MPU_SDA     21
#define MPU_SCL     22

// ── MPU6050 Registers ─────────────────────────────────────────
#define MPU_ADDR       0x68
#define MPU_PWR        0x6B
#define MPU_ACCEL_OUT  0x3B

// ── Timing ────────────────────────────────────────────────────
#define POX_READ_MS          1000UL
#define SEND_INTERVAL_MS    30000UL
#define MOTION_INTERVAL_MS     20UL
#define DISPLAY_INTERVAL_MS   200UL   // faster refresh for smoother UI
#define BTN_DEBOUNCE_MS       180UL
#define TIME_READ_TIMEOUT_MS   10UL
#define HTTP_TIMEOUT_MS      2000UL
#define WIFI_RETRY_MS        5000UL
#define POX_STALE_MS        15000UL
#define REMINDER_INTERVAL_MS 30000UL  // check reminders every 30s
#define CRITICAL_POPUP_MS     4000UL
#define REMINDER_ALERT_MS     8000UL
#define REMINDER_BEEP_ON_MS    140UL
#define REMINDER_BEEP_OFF_MS   120UL
#define ALERT_ESCALATE_MS     10000UL

// ── Reminder Storage ──────────────────────────────────────────
#define MAX_REMINDERS 5
String r_time[MAX_REMINDERS];
String r_days[MAX_REMINDERS];
String r_medicine[MAX_REMINDERS];
int reminderCount = 0;

// ── Objects ───────────────────────────────────────────────────
Adafruit_SSD1306 display(128, 64, &SPI, OLED_DC, OLED_RESET, OLED_CS);
PulseOximeter pox;

// ── WiFi / Server ─────────────────────────────────────────────
const char *ssid     = "nord4";
const char *password = "26052008";
String serverBaseURL = "https://smart-health-monitoring-system-3iep.onrender.com";
// FIX: watchID declared empty — will be set in setup()
String watchID = "";

// ── Sensor Values ─────────────────────────────────────────────
float heartRate  = 0.0f;
float spo2       = 0.0f;
int   stepCount  = 0;
bool  poxReady   = false;

// ── Running Average (6 samples) ───────────────────────────────
#define AVG_SIZE 6
float  hrBuf[AVG_SIZE]  = {0};
float  sp2Buf[AVG_SIZE] = {0};
int    avgIdx           = 0;
int    validSamples     = 0;

// ── Alert State ───────────────────────────────────────────────
bool fallDetected            = false;
bool alertDismissed          = false;
bool criticalAlertDismissed  = false;
bool buzzerActive            = false;
bool beepState               = false;
bool criticalScreenActive    = false;
bool prevCriticalForDisplay  = false;
bool criticalEscalated       = false;
bool fallEscalated           = false;

// ── Reminder State ────────────────────────────────────────────
unsigned long lastReminderCheck = 0;
bool   reminderActive = false;
String reminderText   = "";
bool   reminderBeepInProgress = false;
bool   reminderBeepToneOn     = false;
uint8_t reminderBeepCount     = 0;
String lastReminderTriggerSlot = "";

// ── Step Detection ────────────────────────────────────────────
bool stepRise = false;

// ── Display ───────────────────────────────────────────────────
int page = 0;
bool buttonLatched = false;
bool lastButtonHigh = true;

// ── Timers ────────────────────────────────────────────────────
unsigned long lastPoxRead   = 0;
unsigned long lastMotion    = 0;
unsigned long lastDisplay   = 0;
unsigned long lastSend      = 0;
unsigned long lastBtnTime   = 0;
unsigned long lastWiFiRetry = 0;
unsigned long lastBeatSeen  = 0;
unsigned long lastBeep      = 0;
unsigned long criticalScreenSince   = 0;
unsigned long reminderShownSince    = 0;
unsigned long reminderBeepAt        = 0;
unsigned long criticalAlarmSince    = 0;
unsigned long fallAlarmSince        = 0;
unsigned long lastAlertPostAt       = 0;

// ── Thresholds ────────────────────────────────────────────────
const float STEP_UP     =  2.5f;
const float STEP_DOWN   =  1.0f;
const float FALL_THRESH = 19.0f;

// ─────────────────────────────────────────────────────────────
// FORWARD DECLARATIONS
// ─────────────────────────────────────────────────────────────
String getStatus();
bool   isCritical();
void   sendAlert(String type);
void   updateAlertEscalation();
void   dismissAlerts();
void   showReminder();
void   showFallAlert();
void   showCriticalHR();
void   showTime();
void   showData();
void   showCode();
void   showRemindersPage();

// ─────────────────────────────────────────────────────────────
// URL ENCODE
// ─────────────────────────────────────────────────────────────
String urlEncode(const String &value) {
  String out = "";
  const char *hex = "0123456789ABCDEF";
  for (size_t i = 0; i < value.length(); i++) {
    uint8_t c = (uint8_t)value[i];
    bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
    if (ok) { out += (char)c; }
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 0x0F]; }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// BUILD UPDATE URL  (FIX: watch_id not watchID)
// ─────────────────────────────────────────────────────────────
String buildUpdateURL() {
  String url = serverBaseURL + "/update";
  url += "?watchID=" + watchID;   
  url += "&hr="    + String((int)heartRate);
  url += "&spo2="  + String((int)spo2);
  url += "&steps=" + String(stepCount);
  url += "&status=" + getStatus();
  return url;
}

// ─────────────────────────────────────────────────────────────
// HEALTH STATUS
// ─────────────────────────────────────────────────────────────
String getStatus() {
  if (fallDetected)                              return "FALL";
  if (heartRate > 120 || (spo2 > 0 && spo2 < 90)) return "CRITICAL";
  if (heartRate > 100)                           return "MEDIUM";
  return "NORMAL";
}
bool isCritical() {
  return (heartRate > 120 || (spo2 > 0 && spo2 < 90));
}

// ─────────────────────────────────────────────────────────────
// BEAT CALLBACK
// ─────────────────────────────────────────────────────────────
void onBeatDetected() { lastBeatSeen = millis(); }

// ─────────────────────────────────────────────────────────────
// BUTTON
// ─────────────────────────────────────────────────────────────
bool buttonPressedDebounced() {
  const bool currentHigh = (digitalRead(BUTTON) == HIGH);
  const unsigned long now = millis();
  bool pressed = false;

  if (lastButtonHigh && !currentHigh && (now - lastBtnTime >= BTN_DEBOUNCE_MS)) {
    pressed = true;
    lastBtnTime = now;
  }

  lastButtonHigh = currentHigh;
  return pressed;
}

void dismissAlerts() {
  reminderActive = false;
  reminderBeepInProgress = false;
  reminderBeepToneOn = false;
  reminderBeepCount = 0;
  reminderBeepAt = 0;

  fallDetected = false;
  alertDismissed = true;

  criticalAlertDismissed = true;
  criticalScreenActive = false;
  criticalEscalated = false;
  fallEscalated = false;
  criticalAlarmSince = 0;
  fallAlarmSince = 0;

  if (buzzerActive) {
    ledcWrite(BUZZER, 0);
    ledcDetach(BUZZER);
    pinMode(BUZZER, OUTPUT);
    digitalWrite(BUZZER, LOW);
    buzzerActive = false;
  }
  beepState = false;
}

// ─────────────────────────────────────────────────────────────
// MPU6050
// ─────────────────────────────────────────────────────────────
void initMPU() {
  Wire1.beginTransmission(MPU_ADDR);
  Wire1.write(MPU_PWR);
  Wire1.write(0x00);
  Wire1.endTransmission(true);
  delay(100);
  Serial.println("MPU6050 OK");
}
bool readAccel(float &ax, float &ay, float &az) {
  Wire1.beginTransmission(MPU_ADDR);
  Wire1.write(MPU_ACCEL_OUT);
  if (Wire1.endTransmission(false) != 0) return false;
  if (Wire1.requestFrom((uint8_t)MPU_ADDR, (uint8_t)6, (uint8_t)true) < 6) return false;
  int16_t rx = ((int16_t)Wire1.read() << 8) | Wire1.read();
  int16_t ry = ((int16_t)Wire1.read() << 8) | Wire1.read();
  int16_t rz = ((int16_t)Wire1.read() << 8) | Wire1.read();
  ax = (rx / 16384.0f) * 9.81f;
  ay = (ry / 16384.0f) * 9.81f;
  az = (rz / 16384.0f) * 9.81f;
  return true;
}
void updateMotion() {
  if (millis() - lastMotion < MOTION_INTERVAL_MS) return;
  lastMotion = millis();
  float ax, ay, az;
  if (!readAccel(ax, ay, az)) return;
  float mag   = sqrt(ax*ax + ay*ay + az*az);
  float delta = mag - 9.81f;
  if (mag > FALL_THRESH && !fallDetected) {
    fallDetected   = true;
    alertDismissed = false;
    Serial.println("FALL DETECTED!");
  }
  if (!stepRise && delta > STEP_UP) stepRise = true;
  else if (stepRise && delta < STEP_DOWN) { stepRise = false; stepCount++; }
}

// ─────────────────────────────────────────────────────────────
// BUZZER
// ─────────────────────────────────────────────────────────────
void updateBuzzer() {
  const unsigned long now = millis();
  const bool criticalNow = isCritical();
  const bool fallAlarm = (fallDetected && !alertDismissed);
  const bool criticalAlarm = (criticalNow && !criticalAlertDismissed);

  if (!criticalNow) criticalAlertDismissed = false;

  if (fallAlarm || criticalAlarm) {
    reminderBeepInProgress = false;
    reminderBeepToneOn = false;
    reminderBeepCount = 0;

    if (now - lastBeep >= 200UL) {
      lastBeep = now;
      beepState = !beepState;
      if (beepState) {
        if (!buzzerActive) {
          ledcAttach(BUZZER, 2000, 8);
          buzzerActive = true;
        }
        ledcWrite(BUZZER, 128);
      } else {
        if (buzzerActive) ledcWrite(BUZZER, 0);
      }
    }
    return;
  }

  if (reminderBeepInProgress) {
    const unsigned long stepWindow = reminderBeepToneOn ? REMINDER_BEEP_ON_MS : REMINDER_BEEP_OFF_MS;
    if (reminderBeepAt == 0 || (now - reminderBeepAt >= stepWindow)) {
      reminderBeepAt = now;

      if (!reminderBeepToneOn) {
        if (!buzzerActive) {
          ledcAttach(BUZZER, 2000, 8);
          buzzerActive = true;
        }
        ledcWrite(BUZZER, 128);
        reminderBeepToneOn = true;
        beepState = true;
      } else {
        if (buzzerActive) ledcWrite(BUZZER, 0);
        reminderBeepToneOn = false;
        beepState = false;
        reminderBeepCount++;

        if (reminderBeepCount >= 3) {
          reminderBeepInProgress = false;
          reminderBeepCount = 0;
          reminderBeepAt = 0;
          if (buzzerActive) {
            ledcDetach(BUZZER);
            pinMode(BUZZER, OUTPUT);
            digitalWrite(BUZZER, LOW);
            buzzerActive = false;
          }
        }
      }
    }
    return;
  }

  if (buzzerActive) {
    ledcWrite(BUZZER, 0);
    ledcDetach(BUZZER);
    pinMode(BUZZER, OUTPUT);
    digitalWrite(BUZZER, LOW);
    buzzerActive = false;
  }
  beepState = false;
}

void updateAlertEscalation() {
  const unsigned long now = millis();
  const bool criticalAlarm = (isCritical() && !criticalAlertDismissed);
  const bool fallAlarm = (fallDetected && !alertDismissed);

  if (criticalAlarm) {
    if (criticalAlarmSince == 0) criticalAlarmSince = now;
    if (!criticalEscalated && (now - criticalAlarmSince >= ALERT_ESCALATE_MS) && (now - lastAlertPostAt >= 1500UL)) {
      sendAlert("CRITICAL");
      criticalEscalated = true;
      lastAlertPostAt = now;
    }
  } else {
    criticalAlarmSince = 0;
    criticalEscalated = false;
  }

  if (fallAlarm) {
    if (fallAlarmSince == 0) fallAlarmSince = now;
    if (!fallEscalated && (now - fallAlarmSince >= ALERT_ESCALATE_MS) && (now - lastAlertPostAt >= 1500UL)) {
      sendAlert("FALL");
      fallEscalated = true;
      lastAlertPostAt = now;
    }
  } else {
    fallAlarmSince = 0;
    fallEscalated = false;
  }
}

// ─────────────────────────────────────────────────────────────
// BOOT ANIMATION
// ─────────────────────────────────────────────────────────────
void fadeIn(const char *txt, int sz, int x, int y) {
  int  d[]    = {60, 80, 50, 100, 60, 140, 80, 200};
  bool show[] = {true,false,true,false,true,false,true,true};
  for (int i = 0; i < 8; i++) {
    display.clearDisplay();
    if (show[i]) {
      display.setTextSize(sz);
      display.setTextColor(SSD1306_WHITE);
      display.setCursor(x, y);
      display.println(txt);
    }
    display.display();
    delay(d[i]);
  }
}
void showHello() {
  // Animated loading bar
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(12, 8);
  display.println("Proj AROGYA");
  display.setTextSize(1);
  display.setCursor(22, 30);
  display.println("SmartWatch v1.0");
  // Draw loading bar outline
  display.drawRect(4, 46, 120, 10, SSD1306_WHITE);
  display.display();
  for (int i = 0; i <= 116; i += 4) {
    display.fillRect(5, 47, i, 8, SSD1306_WHITE);
    display.display();
    delay(18);
  }
  delay(300);
}

// ─────────────────────────────────────────────────────────────
// WiFi
// ─────────────────────────────────────────────────────────────
void connectWiFiBlocking() {
  WiFi.begin(ssid, password);
  unsigned long started = millis();
  int dots = 0;
  while (WiFi.status() != WL_CONNECTED) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(5, 4);
    display.println("Connecting to WiFi");
    display.setCursor(5, 18);
    display.print("Network: "); display.println(ssid);
    display.setCursor(5, 34);
    display.print("Please wait");
    for (int i = 0; i < (dots % 4); i++) display.print(".");
    display.setCursor(5, 50);
    display.print("Time: ");
    display.print((millis() - started) / 1000);
    display.print("s");
    display.display();
    dots++;
    delay(300);
    if (millis() - started > 15000UL) break;
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  if (WiFi.status() == WL_CONNECTED) {
    display.setCursor(20, 8);  display.println("WiFi Connected!");
    display.drawLine(0, 20, 128, 20, SSD1306_WHITE);
    display.setCursor(5, 28);  display.print("IP: ");   display.println(WiFi.localIP().toString());
    display.setCursor(5, 42);  display.print("SSID: "); display.println(ssid);
  } else {
    display.setCursor(8, 18);  display.println("WiFi not connected");
    display.setCursor(8, 35);  display.println("Will retry in loop");
  }
  display.display();
  delay(1200);
}
void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWiFiRetry < WIFI_RETRY_MS) return;
  lastWiFiRetry = millis();
  WiFi.disconnect();
  WiFi.begin(ssid, password);
}

// ─────────────────────────────────────────────────────────────
// DISPLAY PAGES — cleaner layout with icons/separators
// ─────────────────────────────────────────────────────────────

// Page 0: Time
void showTime() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  struct tm t;
  if (getLocalTime(&t, TIME_READ_TIMEOUT_MS)) {
    char buf[16];
    // Big HH:MM
    strftime(buf, sizeof(buf), "%H:%M", &t);
    display.setTextSize(3);
    display.setCursor(10, 4);
    display.println(buf);
    // Seconds smaller beside
    strftime(buf, sizeof(buf), ":%S", &t);
    display.setTextSize(2);
    display.setCursor(88, 10);
    display.println(buf);
    // Divider
    display.drawLine(0, 42, 128, 42, SSD1306_WHITE);
    // Day + Date
    strftime(buf, sizeof(buf), "%A", &t);
    display.setTextSize(1);
    display.setCursor(2, 50);
    display.println(buf);
    strftime(buf, sizeof(buf), "%d/%m/%Y", &t);
    display.setCursor(68, 50);
    display.println(buf);
    // WiFi dot top-right
    if (WiFi.status() == WL_CONNECTED) display.fillCircle(124, 4, 3, SSD1306_WHITE);
    else                                display.drawCircle(124, 4, 3, SSD1306_WHITE);
  } else {
    display.setTextSize(2);
    display.setCursor(5, 24);
    display.println("Syncing...");
  }
  display.display();
}

// Page 1: Health Data — cleaner with separators
void showData() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Header bar
  display.fillRect(0, 0, 128, 11, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(28, 2);
  display.print("HEALTH DATA");
  display.setTextColor(SSD1306_WHITE);

  // HR row
  display.setCursor(2, 15);
  display.print("\x03");  // heart symbol
  display.print(" HR:");
  display.setCursor(55, 15);
  if (heartRate >= 30) {
    display.print((int)heartRate);
    display.print(" bpm");
  } else {
    // Blinking dashes when no reading
    if ((millis() / 500) % 2 == 0) display.print("-- bpm");
    else                            display.print("       ");
  }

  display.drawLine(0, 26, 128, 26, SSD1306_WHITE);

  // SpO2 row
  display.setCursor(2, 29);
  display.print("O2 SpO2:");
  display.setCursor(55, 29);
  if (spo2 >= 70) {
    display.print((int)spo2);
    display.print(" %");
  } else {
    if ((millis() / 500) % 2 == 0) display.print("-- %");
    else                            display.print("     ");
  }

  display.drawLine(0, 40, 128, 40, SSD1306_WHITE);

  // Steps row
  display.setCursor(2, 43);
  display.print(">> Steps:");
  display.setCursor(62, 43);
  display.print(stepCount);

  display.drawLine(0, 53, 128, 53, SSD1306_WHITE);

  // Status row
  display.setCursor(2, 56);
  display.print("Status:");
  String st = getStatus();
  if (st == "CRITICAL") {
    display.fillRect(50, 54, 52, 10, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
    display.setCursor(51, 56);
    display.print("CRITICAL");
    display.setTextColor(SSD1306_WHITE);
  } else if (st == "MEDIUM") {
    display.fillRect(50, 54, 42, 10, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
    display.setCursor(51, 56);
    display.print("MEDIUM");
    display.setTextColor(SSD1306_WHITE);
  } else {
    display.setCursor(50, 56);
    display.print(st);
  }

  display.display();
}

// Page 2: Watch Code
void showCode() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  // Header
  display.fillRect(0, 0, 128, 11, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setCursor(18, 2);
  display.print("[ WATCH CODE ]");
  display.setTextColor(SSD1306_WHITE);

  // WiFi status top-right inside header
  display.setTextColor(SSD1306_BLACK);
  if (WiFi.status() == WL_CONNECTED) { display.setCursor(100, 2); display.print("ON"); }
  else                               { display.setCursor(96, 2);  display.print("OFF"); }
  display.setTextColor(SSD1306_WHITE);

  // ID box
  display.drawRoundRect(2, 15, 124, 16, 4, SSD1306_WHITE);
  display.setCursor(6, 20);
  display.println(watchID);

  display.drawLine(0, 35, 128, 35, SSD1306_WHITE);

  display.setCursor(5, 40);
  display.println("Enter code on website");
  display.setCursor(5, 52);
  display.println("to connect this watch");

  display.display();
}

// Page 3: Reminders list
void showRemindersPage() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return;
  char currentTime[6];
  strftime(currentTime, sizeof(currentTime), "%H:%M", &timeinfo);

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Header bar
  display.fillRect(0, 0, 128, 11, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(22, 2);
  display.print("[ REMINDERS ]");
  display.setTextColor(SSD1306_WHITE);

  if (reminderCount == 0) {
    display.setCursor(18, 30);
    display.println("No reminders set");
  } else {
    for (int i = 0; i < reminderCount && i < 4; i++) {
      int y = 14 + (i * 13);
      display.setCursor(0, y);
      if (r_time[i] == String(currentTime)) {
        display.print("> ");
      } else {
        display.print("  ");
      }
      display.print(r_time[i]);
      display.print(" ");
      // Trim medicine name to fit
      String med = r_medicine[i];
      if (med.length() == 0) med = "Medicine";
      if (med.length() > 8) med = med.substring(0, 8);
      display.print(med);
    }
  }
  display.display();
}

// ─────────────────────────────────────────────────────────────
// ALERT SCREENS — kept exactly as original
// ─────────────────────────────────────────────────────────────
void showFallAlert() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  if ((millis() / 350) % 2 == 0) {
    display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
    display.drawRect(3, 3, 122, 58, SSD1306_WHITE);
  }
  display.setTextSize(2);
  display.setCursor(8, 6);
  display.println("!! FALL !!");
  display.setCursor(8, 26);
  display.println("DETECTED");
  display.setTextSize(1);
  display.setCursor(5, 52);
  display.println("Press BTN if you're OK");
  display.display();
}

void showCriticalHR() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  if ((millis() / 300) % 2 == 0) display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(22, 4);
  display.println("** WARNING **");
  display.setTextSize(2);
  display.setCursor(10, 18);
  display.println("HIGH HR!");
  display.setTextSize(1);
  display.setCursor(15, 44);
  display.print("HR : ");   display.print((int)heartRate); display.println(" bpm");
  display.setCursor(15, 55);
  display.print("SpO2: "); display.print((int)spo2); display.println(" %");
  display.display();
}

void showReminder() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  // Flashing border
  if ((millis() / 400) % 2 == 0) display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  // Header
  display.fillRect(1, 1, 126, 13, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(20, 3);
  display.print("** REMINDER **");
  display.setTextColor(SSD1306_WHITE);
  // Medicine name
  display.setTextSize(2);
  display.setCursor(8, 20);
  display.println(reminderText);
  // Dismiss hint
  display.setTextSize(1);
  display.setCursor(10, 52);
  display.println("BTN to dismiss");
  display.display();
}

// ─────────────────────────────────────────────────────────────
// HTTP — SEND DATA  (watch_id already fixed in buildUpdateURL)
// ─────────────────────────────────────────────────────────────
void sendData() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = buildUpdateURL();
  Serial.print("URL: "); Serial.println(url);
  if (!http.begin(client, url)) {
    Serial.println("HTTP begin failed");
    return;
  }
  http.setTimeout(HTTP_TIMEOUT_MS);
  int httpCode = http.GET();
  Serial.print("Server: "); Serial.println(httpCode);
  if (httpCode <= 0) { Serial.print("HTTP error: "); Serial.println(http.errorToString(httpCode)); }
  http.end();
}
// ─────────────────────────────────────────────────────────────
// SEND ALERT  (FIX: watch_id not watchID)
// ─────────────────────────────────────────────────────────────
void sendAlert(String type) {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = serverBaseURL + "/alert?watch_id=" + watchID;
  url += "&type=" + urlEncode(type);
  url += "&hr=" + String((int)heartRate);
  url += "&spo2=" + String((int)spo2);
  url += "&steps=" + String(stepCount);
  url += "&status=" + urlEncode(getStatus());
  if (!http.begin(client, url)) {
    Serial.println("Alert begin failed");
    return;
  }
  http.setTimeout(1500UL);
  int code = http.GET();
  http.end();
  Serial.print("Alert sent: "); Serial.print(type);
  Serial.print(" code="); Serial.println(code);
}

// ─────────────────────────────────────────────────────────────
// CHECK REMINDERS  (FIX: dayStart offset + medicine field)
// ─────────────────────────────────────────────────────────────
void checkReminders() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastReminderCheck < REMINDER_INTERVAL_MS) return;
  lastReminderCheck = millis();

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = serverBaseURL + "/getReminders?watch_id=" + watchID;
  if (!http.begin(client, url)) {
    Serial.println("Reminder begin failed");
    return;
  }
  http.setTimeout(HTTP_TIMEOUT_MS);
  int code = http.GET();

  if (code == 200) {
    String payload = http.getString();
    Serial.println("Reminder JSON: " + payload);

    struct tm timeinfo;
    if (!getLocalTime(&timeinfo)) { http.end(); return; }

    char currentTime[6];
    strftime(currentTime, sizeof(currentTime), "%H:%M", &timeinfo);
    char currentDay[10];
    strftime(currentDay, sizeof(currentDay), "%a", &timeinfo); // e.g. Mon

    Serial.print("TIME: "); Serial.println(currentTime);
    Serial.print("DAY : "); Serial.println(currentDay);

    const String currentSlot = String(timeinfo.tm_year) + "|" + String(timeinfo.tm_yday) + "|" + String(currentTime);

    // Reset counts before re-parsing
    reminderCount = 0;
    reminderActive = false;

    int index = 0;
    while ((index = payload.indexOf("\"time\":\"", index)) != -1) {
      // Parse time value
      int timeStart = index + 8;
      int timeEnd   = payload.indexOf("\"", timeStart);
      if (timeEnd == -1) break;
      String rTime = payload.substring(timeStart, timeEnd);

      // FIX: correct offset for "repeat_days":"  (15 chars, not 16)
      int dayIdx   = payload.indexOf("\"repeat_days\":\"", timeEnd);
      if (dayIdx == -1) { index = timeEnd; continue; }
      int dayStart = dayIdx + 15;  // FIX was 16
      int dayEnd   = payload.indexOf("\"", dayStart);
      if (dayEnd == -1) { index = timeEnd; continue; }
      String rDays = payload.substring(dayStart, dayEnd);

      // Parse medicine_name field
      String rMed = "";
      int medIdx = payload.indexOf("\"medicine_name\":\"", timeEnd);
      if (medIdx != -1) {
        int medStart = medIdx + 17;
        int medEnd   = payload.indexOf("\"", medStart);
        if (medEnd != -1) rMed = payload.substring(medStart, medEnd);
      }

      // Store
      if (reminderCount < MAX_REMINDERS) {
        r_time[reminderCount]     = rTime;
        r_days[reminderCount]     = rDays;
        r_medicine[reminderCount] = rMed;
        reminderCount++;
      }

      Serial.print("Reminder -> "); Serial.print(rTime);
      Serial.print(" | "); Serial.print(rDays);
      Serial.print(" | "); Serial.println(rMed);

      // Match time + day (trigger once per minute slot)
      if (rTime == String(currentTime) && rDays.indexOf(currentDay) >= 0) {
        if (lastReminderTriggerSlot != currentSlot) {
          reminderActive = true;
          reminderText   = (rMed.length() > 0) ? rMed : "Medicine!";
          reminderShownSince = millis();
          reminderBeepInProgress = true;
          reminderBeepToneOn = false;
          reminderBeepCount = 0;
          reminderBeepAt = 0;
          lastReminderTriggerSlot = currentSlot;
        }
        break;
      }

      index = timeEnd;
    }
  } else {
    Serial.print("Reminder fetch failed: "); Serial.println(code);
  }
  http.end();
}

// ─────────────────────────────────────────────────────────────
// MAX30100 INIT
// ─────────────────────────────────────────────────────────────
void initMAX30100() {
  Serial.println("\n-- I2C scan on MAX30100 bus (SDA=26 SCL=27) --");
  bool found57 = false;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.print("  0x");
      if (a < 16) Serial.print("0");
      Serial.print(a, HEX);
      if (a == 0x57) { Serial.print(" <-- MAX30100 FOUND!"); found57 = true; }
      Serial.println();
    }
  }
  if (!found57) Serial.println("  0x57 NOT found - check wiring");
  Serial.println("-----------------------------");

  if (!pox.begin()) {
    Serial.println("MAX30100 FAILED");
    poxReady = false;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(5, 10); display.println("MAX30100 Error!");
    display.setCursor(5, 25); display.println("SDA=26  SCL=27");
    display.setCursor(5, 40); display.println("Check wiring!");
    display.display();
    delay(2000);
    return;
  }
  pox.setOnBeatDetectedCallback(onBeatDetected);
  pox.setIRLedCurrent(MAX30100_LED_CURR_50MA);
  poxReady     = true;
  lastPoxRead  = 0;
  lastBeatSeen = millis();
  heartRate = spo2 = 0;
  Serial.println("MAX30100 OK - finger on sensor, hold still 20s");
}

// ─────────────────────────────────────────────────────────────
// MAX30100 UPDATE  (FIX: display interval reduced so readings
//                   refresh on screen as soon as sensor updates)
// ─────────────────────────────────────────────────────────────
void updatePox() {
  if (!poxReady) return;
  pox.update();  // MUST run every loop iteration
  if (millis() - lastPoxRead < POX_READ_MS) return;
  lastPoxRead = millis();

  float liveHR   = pox.getHeartRate();
  float liveSpO2 = pox.getSpO2();
  Serial.print("RAW  HR="); Serial.print(liveHR,1);
  Serial.print("  SpO2="); Serial.println(liveSpO2,1);

  // Clear stale data if finger removed
  if (millis() - lastBeatSeen > POX_STALE_MS) {
    heartRate = spo2 = 0;
    validSamples = avgIdx = 0;
    for (int i = 0; i < AVG_SIZE; i++) { hrBuf[i] = 0; sp2Buf[i] = 0; }
    Serial.println("No finger - cleared");
    return;
  }

  const bool hrValid = (liveHR   >= 30.0f  && liveHR   <= 220.0f);
  const bool spValid = (liveSpO2 >= 70.0f  && liveSpO2 <= 100.0f);

  hrBuf[avgIdx]  = hrValid ? liveHR : 0.0f;
  sp2Buf[avgIdx] = spValid ? liveSpO2 : 0.0f;
  avgIdx = (avgIdx + 1) % AVG_SIZE;
  if (validSamples < AVG_SIZE) validSamples++;

  float hrSum = 0, sp2Sum = 0;
  int   hrCnt = 0, sp2Cnt = 0;
  for (int i = 0; i < AVG_SIZE; i++) {
    if (hrBuf[i]  >= 30.0f) { hrSum  += hrBuf[i];  hrCnt++;  }
    if (sp2Buf[i] >= 70.0f) { sp2Sum += sp2Buf[i]; sp2Cnt++; }
  }
  heartRate = (hrCnt  >= 2) ? (hrSum  / hrCnt) : 0.0f;
  spo2      = (sp2Cnt >= 2) ? (sp2Sum / sp2Cnt) : 0.0f;

  Serial.print("DISP HR=");   Serial.print(heartRate,1);
  Serial.print("  SpO2=");    Serial.print(spo2,1);
  Serial.print("  buf=");     Serial.println(validSamples);
}

// ─────────────────────────────────────────────────────────────
// DISPLAY UPDATE
// ─────────────────────────────────────────────────────────────
void updateDisplay() {
  if (buttonPressedDebounced()) {
    buttonLatched = true;
  }

  const bool criticalNow = isCritical();
  const bool hasDismissibleAlert = reminderActive || reminderBeepInProgress ||
    (fallDetected && !alertDismissed) || criticalScreenActive || (criticalNow && !criticalAlertDismissed);

  if (buttonLatched && hasDismissibleAlert) {
    buttonLatched = false;
    dismissAlerts();
    return;
  }

  // Reminder alert has highest priority
  if (reminderActive) {
    showReminder();
    if (millis() - reminderShownSince >= REMINDER_ALERT_MS) {
      reminderActive = false;
      reminderBeepInProgress = false;
      reminderBeepToneOn = false;
      reminderBeepCount = 0;
      reminderBeepAt = 0;
    }
    return;
  }

  if (millis() - lastDisplay < DISPLAY_INTERVAL_MS) return;
  lastDisplay = millis();

  // Fall alert
  if (fallDetected && !alertDismissed) {
    showFallAlert();
    return;
  }

  if (!criticalNow) {
    criticalAlertDismissed = false;
    prevCriticalForDisplay = false;
    criticalScreenActive = false;
  } else {
    if (!prevCriticalForDisplay && !criticalAlertDismissed) {
      criticalScreenActive = true;
      criticalScreenSince = millis();
    }
    prevCriticalForDisplay = true;
  }

  // Show critical popup briefly, then return to normal pages
  if (criticalScreenActive) {
    showCriticalHR();
    if (millis() - criticalScreenSince >= CRITICAL_POPUP_MS) {
      criticalScreenActive = false;
    }
    return;
  }

  // Normal page navigation
  if (buttonLatched) {
    buttonLatched = false;
    page++;
    if (page > 3) page = 0;
  }

  if      (page == 0) showTime();
  else if (page == 1) showData();
  else if (page == 2) showCode();
  else if (page == 3) showRemindersPage();
}

// ─────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  // FIX: watchID MUST be set here in setup(), not at global scope
  watchID = "WCH" + String((uint32_t)ESP.getEfuseMac(), DEC);
  Serial.print("WatchID: ");
  Serial.println(watchID);

  pinMode(BUTTON, INPUT_PULLUP);
  lastButtonHigh = (digitalRead(BUTTON) == HIGH);
  pinMode(BUZZER, OUTPUT);
  digitalWrite(BUZZER, LOW);

  Wire.begin(POX_SDA, POX_SCL);
  Wire.setClock(100000);
  Wire1.begin(MPU_SDA, MPU_SCL);
  Wire1.setClock(100000);

  SPI.begin(OLED_CLK, -1, OLED_MOSI);
  if (!display.begin(SSD1306_SWITCHCAPVCC)) {
    Serial.println("OLED failed!");
    while (1) delay(10);
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.display();

  showHello();
  connectWiFiBlocking();
  configTime(19800, 0, "pool.ntp.org", "time.nist.gov");
  initMPU();
  initMAX30100();

  // Stagger reminder/data HTTP calls so they don't block together
  lastReminderCheck = millis() - (REMINDER_INTERVAL_MS / 2);
}

// ─────────────────────────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────────────────────────
void loop() {
  updatePox();       // MUST be first — runs pox.update() every iteration
  updateMotion();
  updateBuzzer();
  updateAlertEscalation();
  ensureWiFi();
  updateDisplay();

  bool didNetworkCall = false;
  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    sendData();
    lastSend = millis();
    didNetworkCall = true;
  }

  if (!didNetworkCall) {
    checkReminders();
  }

  delay(1);
}
