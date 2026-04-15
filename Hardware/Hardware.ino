  #include <Adafruit_GFX.h>
  #include <Adafruit_SSD1306.h>
  #include <WiFi.h>
  #include <SPI.h>
  #include <Wire.h>
  #include <time.h>
  #include <HTTPClient.h>
  #include <WiFiClient.h>
  #include "MAX30100_PulseOximeter.h"
  // Pin Definitions
  #define OLED_MOSI   23
  #define OLED_CLK    18
  #define OLED_DC     33
  #define OLED_CS      5
  #define OLED_RESET  25
  #define BUTTON      19
  #define BUZZER      32
  // I2C Bus pins
  // MAX30100 must be on default Wire bus because library uses Wire internally
  #define POX_SDA     26
  #define POX_SCL     27
  // MPU6050 moved to Wire1 bus
  #define MPU_SDA     21
  #define MPU_SCL     22
  // MPU6050 Registers
  #define MPU_ADDR       0x68
  #define MPU_PWR        0x6B
  #define MPU_ACCEL_OUT  0x3B
  // Timing
  #define POX_READ_MS          3000UL
  #define SEND_INTERVAL_MS    30000UL
  #define MOTION_INTERVAL_MS     20UL
  #define DISPLAY_INTERVAL_MS   300UL
  #define BTN_DEBOUNCE_MS       300UL
  #define TIME_READ_TIMEOUT_MS   10UL
  #define HTTP_TIMEOUT_MS      4000UL
  #define WIFI_RETRY_MS        5000UL
  #define POX_STALE_MS        15000UL
  #define MAX_REMINDERS 5

  String r_time[MAX_REMINDERS];
  String r_days[MAX_REMINDERS];
  int reminderCount = 0;
  // Objects
  Adafruit_SSD1306 display(128, 64, &SPI, OLED_DC, OLED_RESET, OLED_CS);
  PulseOximeter pox;
  // WiFi / Server
  const char *ssid     = "nord4";
  const char *password = "26052008";
  String serverBaseURL = "https://smart-health-monitoring-system-3iep.onrender.com";
  const char *serverUpdatePath = "/update";
  String watchID = "";


  // Sensor Values
  float heartRate  = 0.0f;
  float spo2       = 0.0f;
  int   stepCount  = 0;
  bool  poxReady   = false;
  // Running Average (6 samples)
  #define AVG_SIZE    6
  float  hrBuf[AVG_SIZE]  = {0};
  float  sp2Buf[AVG_SIZE] = {0};
  int    avgIdx           = 0;
  int    validSamples     = 0;
  // Alert State
  bool fallDetected   = false;
  bool alertDismissed = false;
  bool criticalAlertDismissed = false;   // <-- ADD THIS
  bool buzzerActive   = false;
  bool beepState      = false;
  // Step Detection
  bool stepRise = false;

  String urlEncode(const String &value) {
    String out = "";
    const char *hex = "0123456789ABCDEF";
    for (size_t i = 0; i < value.length(); i++) {
      uint8_t c = (uint8_t)value[i];
      bool ok = (c >= 'a' && c <= 'z') ||
                (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') ||
                c == '-' || c == '_' || c == '.' || c == '~';
      if (ok) {
        out += (char)c;
      } else {
        out += '%';
        out += hex[c >> 4];
        out += hex[c & 0x0F];
      }
    }
    return out;
  }

  String buildUpdateURL() {
    String url = serverBaseURL + String(serverUpdatePath);
    url += "?watch_id=" + watchID;
    url += "&hr=" + String((int)heartRate);
    url += "&spo2=" + String((int)spo2);
    url += "&steps=" + String(stepCount);

    // SIMPLE status (NO encoding)
    url += "&status=" + getStatus();

    return url;
  } 
  // 🔔 REMINDER FEATURE
  unsigned long lastReminderCheck = 0;
  #define REMINDER_INTERVAL_MS 60000UL   // check every 1 min
  bool reminderActive = false;
  String reminderText = "";

  // ALERT TRACK
  bool lastCriticalState = false;

  // Display
  int page = 0;
  // Timers
  unsigned long lastPoxRead   = 0;
  unsigned long lastMotion    = 0;
  unsigned long lastDisplay   = 0;
  unsigned long lastSend      = 0;
  unsigned long lastBtnTime   = 0;
  unsigned long lastWiFiRetry = 0;
  unsigned long lastBeatSeen  = 0;
  unsigned long lastBeep      = 0;
  // Thresholds
  const float STEP_UP     =  2.5f;
  const float STEP_DOWN   =  1.0f;
  const float FALL_THRESH = 19.0f;
  // BEAT CALLBACK
  void onBeatDetected() {
    lastBeatSeen = millis();
  }
  // BUTTON
  bool buttonPressedDebounced() {
    if (digitalRead(BUTTON) != LOW) return false;
    if (millis() - lastBtnTime < BTN_DEBOUNCE_MS) return false;
    lastBtnTime = millis();
    return true;
  }
  // MPU6050 (uses Wire1 bus)
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
    float mag   = sqrt(ax * ax + ay * ay + az * az);
    float delta = mag - 9.81f;
    if (mag > FALL_THRESH && !fallDetected) {
      fallDetected   = true;
      alertDismissed = false;
      Serial.println("FALL DETECTED!");
      sendAlert("FALL");
    }
    if (!stepRise && delta > STEP_UP) stepRise = true;
    else if (stepRise && delta < STEP_DOWN) {
      stepRise = false;
      stepCount++;
    }
  }
  // HEALTH STATUS
  String getStatus() {
    if (fallDetected) return "FALL";
    if (heartRate > 120 || (spo2 > 0 && spo2 < 90)) return "CRITICAL";
    if (heartRate > 100) return "MEDIUM";
    return "NORMAL";
  }
  bool isCritical() {
    return (heartRate > 120 || (spo2 > 0 && spo2 < 90));
  }
  // BUZZER
  void updateBuzzer() {
    
    // Re-arm critical alarm automatically when vitals become normal
    if (!isCritical()) {
      criticalAlertDismissed = false;
    }
    bool shouldBuzz = (fallDetected && !alertDismissed) || (isCritical() && !criticalAlertDismissed);
    if (!shouldBuzz) {
      if (buzzerActive) {
        ledcDetach(BUZZER);
        pinMode(BUZZER, OUTPUT);
        digitalWrite(BUZZER, LOW);
        buzzerActive = false;
        beepState    = false;
      }
      return;
    }
    buzzerActive = true;
    if (millis() - lastBeep >= 200UL) {
      lastBeep  = millis();
      beepState = !beepState;
      if (beepState) {
        ledcAttach(BUZZER, 2000, 8);
        ledcWrite(BUZZER, 128);
      } else {
        ledcWrite(BUZZER, 0);
      }
    }
    if (isCritical() && !lastCriticalState) {
    sendAlert("CRITICAL");
  }
  lastCriticalState = isCritical();
  }
  // DISPLAY HELPERS
  void fadeIn(const char *txt, int sz, int x, int y) {
    int  d[]    = {60, 80, 50, 100, 60, 140, 80, 200};
    bool show[] = {true, false, true, false, true, false, true, true};
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
    fadeIn("HELLO", 3, 15, 15);
    delay(300);
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(22, 50);
    display.println("SmartWatch v1.0");
    display.display();
    delay(1200);
  }
  // WiFi
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
      display.print("Network: ");
      display.println(ssid);
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
      display.setCursor(20, 8);
      display.println("WiFi Connected!");
      display.drawLine(0, 20, 128, 20, SSD1306_WHITE);
      display.setCursor(5, 28);
      display.print("IP: ");
      display.println(WiFi.localIP().toString());
      display.setCursor(5, 42);
      display.print("SSID: ");
      display.println(ssid);
    } else {
      display.setCursor(8, 18);
      display.println("WiFi not connected");
      display.setCursor(8, 35);
      display.println("Will retry in loop");
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
  // DISPLAY PAGES
  void showTime() {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    struct tm t;
    if (getLocalTime(&t, TIME_READ_TIMEOUT_MS)) {
      char buf[16];
      strftime(buf, sizeof(buf), "%H:%M", &t);
      display.setTextSize(3);
      display.setCursor(10, 6);
      display.println(buf);
      strftime(buf, sizeof(buf), ":%S", &t);
      display.setTextSize(2);
      display.setCursor(88, 12);
      display.println(buf);
      display.drawLine(0, 42, 128, 42, SSD1306_WHITE);
      strftime(buf, sizeof(buf), "%A", &t);
      display.setTextSize(1);
      display.setCursor(2, 50);
      display.println(buf);
      strftime(buf, sizeof(buf), "%d/%m/%Y", &t);
      display.setCursor(68, 50);
      display.println(buf);
    } else {
      display.setTextSize(2);
      display.setCursor(5, 24);
      display.println("Syncing...");
    }
    display.display();
  }
  void showData() {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.print("HR    : ");
    if (heartRate >= 30) {
      display.print((int)heartRate);
      display.print(" bpm");
    } else {
      if ((millis() / 500) % 2 == 0) display.print("-- bpm");
      else display.print("   bpm");
    }
    display.setCursor(0, 11);
    display.print("SpO2  : ");
    if (spo2 >= 70) {
      display.print((int)spo2);
      display.print(" %");
    } else {
      if ((millis() / 500) % 2 == 0) display.print("-- %");
      else display.print("   %");
    }
    display.setCursor(0, 22);
    display.print("Steps : ");
    display.print(stepCount);
    display.setCursor(0, 33);
    display.print("Status: ");
    String st = getStatus();
    if (st == "CRITICAL") {
      display.fillRect(48, 31, 52, 10, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
      display.setCursor(49, 33);
      display.print("CRITICAL");
      display.setTextColor(SSD1306_WHITE);
    } else {
      display.print(st);
    }
    display.setCursor(0, 44);
    display.print("WiFi  : ");
    display.print(WiFi.status() == WL_CONNECTED ? "ON" : "OFF");
    struct tm t;
    if (getLocalTime(&t, TIME_READ_TIMEOUT_MS)) {
      char buf[12];
      strftime(buf, sizeof(buf), "%d/%m/%Y", &t);
      display.setCursor(0, 55);
      display.print("Date  : ");
      display.print(buf);
    }
    display.display();
  }
  void showCode() {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(18, 2);
    display.println("[ WATCH CODE ]");
    display.drawLine(0, 13, 128, 13, SSD1306_WHITE);
    display.drawRoundRect(2, 18, 124, 22, 4, SSD1306_WHITE);
    display.setCursor(6, 25);
    display.println(watchID);
    display.drawLine(0, 44, 128, 44, SSD1306_WHITE);
    display.setCursor(5, 48);
    display.println("Enter code on website");
    display.setCursor(5, 57);
    display.println("to connect this watch");
    if (WiFi.status() == WL_CONNECTED) {
      display.setCursor(84, 0);
      display.print("ON");
    } else {
      display.setCursor(80, 0);
      display.print("OFF");
    }
    display.display();
  }
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
    display.setTextSize(2);
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
    display.print("HR : ");
    display.print((int)heartRate);
    display.println(" bpm");
    display.setCursor(15, 55);
    display.print("SpO2: ");
    display.print((int)spo2);
    display.println(" %");
    display.display();
  }
  // HTTP SEND
  void sendData() {
    if (WiFi.status() != WL_CONNECTED) return;
    WiFiClient client;
    HTTPClient http;
    String url = buildUpdateURL();
    Serial.print("URL: ");
    Serial.println(url);
    http.begin(client, url);
    http.setTimeout(HTTP_TIMEOUT_MS);
    int httpCode = http.GET();
    Serial.print("Server: ");
    Serial.println(httpCode);
    if (httpCode <= 0) {
      Serial.print("HTTP error: ");
      Serial.println(http.errorToString(httpCode));
    }
    http.end();
  }
  // MAX30100 INIT (uses default Wire bus)
  void initMAX30100() {
    Serial.print("MAX30100 init (default Wire, SDA=26 SCL=27)... ");
    // Quick I2C scan on Wire to verify sensor is visible
    Serial.println("\n-- I2C scan on MAX30100 bus --");
    bool found57 = false;
    for (uint8_t a = 1; a < 127; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0) {
        Serial.print("  0x");
        if (a < 16) Serial.print("0");
        Serial.print(a, HEX);
        if (a == 0x57) {
          Serial.print(" <-- MAX30100 FOUND!");
          found57 = true;
        }
        Serial.println();
      }
    }
    if (!found57) {
      Serial.println("  0x57 NOT found - check SDA=26, SCL=27 wiring to MAX30100");
    }
    Serial.println("-----------------------------");
    if (!pox.begin()) {
      Serial.println("FAILED");
      poxReady = false;
      display.clearDisplay();
      display.setTextSize(1);
      display.setTextColor(SSD1306_WHITE);
      display.setCursor(5, 10);
      display.println("MAX30100 Error!");
      display.setCursor(5, 25);
      display.println("SDA=26  SCL=27");
      display.setCursor(5, 40);
      display.println("Check wiring!");
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
    Serial.println("OK - finger on sensor, hold still 20s");
  }
  // MAX30100 UPDATE
  void updatePox() {
    if (!poxReady) return;
    pox.update();  // MUST run every loop
    if (millis() - lastPoxRead < POX_READ_MS) return;
    lastPoxRead = millis();
    float liveHR   = pox.getHeartRate();
    float liveSpO2 = pox.getSpO2();
    Serial.print("RAW  HR=");
    Serial.print(liveHR, 1);
    Serial.print("  SpO2=");
    Serial.println(liveSpO2, 1);
    if (millis() - lastBeatSeen > POX_STALE_MS) {
      heartRate = spo2 = 0;
      validSamples = avgIdx = 0;
      for (int i = 0; i < AVG_SIZE; i++) {
        hrBuf[i] = 0;
        sp2Buf[i] = 0;
      }
      Serial.println("No finger - cleared");
      return;
    }
    if (liveHR >= 30.0f && liveHR <= 220.0f) hrBuf[avgIdx] = liveHR;
    if (liveSpO2 >= 70.0f && liveSpO2 <= 100.0f) sp2Buf[avgIdx] = liveSpO2;
    avgIdx = (avgIdx + 1) % AVG_SIZE;
    if (validSamples < AVG_SIZE) validSamples++;
    float hrSum = 0, sp2Sum = 0;
    int hrCnt = 0, sp2Cnt = 0;
    for (int i = 0; i < AVG_SIZE; i++) {
      if (hrBuf[i] >= 30.0f) {
        hrSum += hrBuf[i];
        hrCnt++;
      }
      if (sp2Buf[i] >= 70.0f) {
        sp2Sum += sp2Buf[i];
        sp2Cnt++;
      }
    }
    if (hrCnt >= 2) heartRate = hrSum / hrCnt;
    if (sp2Cnt >= 2) spo2 = sp2Sum / sp2Cnt;
    Serial.print("DISP HR=");
    Serial.print(heartRate, 1);
    Serial.print("  SpO2=");
    Serial.print(spo2, 1);
    Serial.print("  buf=");
    Serial.println(validSamples);
  }
  // DISPLAY UPDATE
  void updateDisplay() {
    if (reminderActive) {
    showReminder();

    if (buttonPressedDebounced()) {
      reminderActive = false;
    }
    return;
  }
    if (millis() - lastDisplay < DISPLAY_INTERVAL_MS) return;
    lastDisplay = millis();
    if (fallDetected && !alertDismissed) {
      showFallAlert();
      if (buttonPressedDebounced()) {
        fallDetected = false;
        alertDismissed = true;
      }
      return;
    }
    // Re-arm critical dismiss when condition is gone
    if (!isCritical()) {
      criticalAlertDismissed = false;
    }
    // Show critical warning only if not dismissed
    if (isCritical() && !criticalAlertDismissed) {
      showCriticalHR();
      if (buttonPressedDebounced()) {
        criticalAlertDismissed = true;   // <-- dismiss alarm on button press
      }
      return;
    }
    if (buttonPressedDebounced()) {
      page++;
      if (page > 3) page = 0;
    }
    if (page == 0) showTime();
  else if (page == 1) showData();
  else if (page == 2) showCode();
  else if (page == 3) showRemindersPage();
  }
  // SETUP
  void setup() {
    Serial.begin(115200);
    watchID = "WCH" + String((uint32_t)ESP.getEfuseMac(), DEC);

Serial.print("WatchID: ");
Serial.println(watchID);
    delay(500);
    pinMode(BUTTON, INPUT_PULLUP);
    pinMode(BUZZER, OUTPUT);
    digitalWrite(BUZZER, LOW);
    // MAX30100 on default Wire bus (required by library)
    Wire.begin(POX_SDA, POX_SCL);
    Wire.setClock(100000);
    // MPU6050 on Wire1
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
  }
  // LOOP
  void loop() {
    checkReminders();
    updatePox();
    updateMotion();
    updateBuzzer();
    ensureWiFi();
    if (millis() - lastSend >= SEND_INTERVAL_MS) {
      sendData();
      lastSend = millis();
    }
    updateDisplay();
    delay(1);
  }
  void sendAlert(String type) {
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClient client;
    HTTPClient http;

    String url = serverBaseURL + "/alert?watchID=" + watchID + "&type=" + type;

    http.begin(client, url);
    http.GET();
    http.end();

    Serial.println("Alert sent: " + type);
  }
  void checkReminders() {
    reminderCount = 0;
    if (WiFi.status() != WL_CONNECTED) return;
    if (millis() - lastReminderCheck < REMINDER_INTERVAL_MS) return;

    lastReminderCheck = millis();

    WiFiClient client;
    HTTPClient http;

    String url = serverBaseURL + "/getReminders?watch_id=" + watchID;

    http.begin(client, url);
    int code = http.GET();

    if (code == 200) {
      String payload = http.getString();

      Serial.println("Reminder JSON:");
      Serial.println(payload);

      struct tm timeinfo;
      if (!getLocalTime(&timeinfo)) return;

      char currentTime[6];
      strftime(currentTime, sizeof(currentTime), "%H:%M", &timeinfo);

      char currentDay[10];
      strftime(currentDay, sizeof(currentDay), "%a", &timeinfo); // Mon

      Serial.print("TIME: "); Serial.println(currentTime);
      Serial.print("DAY : "); Serial.println(currentDay);

      reminderActive = false; // reset before checking

      // 🔥 LOOP THROUGH ALL REMINDERS (STRING PARSE METHOD)
      int index = 0;

      while ((index = payload.indexOf("\"time\":\"", index)) != -1) {

        int timeStart = index + 8;
        int timeEnd = payload.indexOf("\"", timeStart);
        String reminderTime = payload.substring(timeStart, timeEnd);

        int dayIndex = payload.indexOf("\"repeat_days\":\"", timeEnd);
        int dayStart = dayIndex + 16;
        int dayEnd = payload.indexOf("\"", dayStart);
        String reminderDays = payload.substring(dayStart, dayEnd);
        if (reminderCount < MAX_REMINDERS) {
        r_time[reminderCount] = reminderTime;
        r_days[reminderCount] = reminderDays;
        reminderCount++;
        }

        Serial.print("Check -> ");
        Serial.print(reminderTime);
        Serial.print(" | ");
        Serial.println(reminderDays);

        // ✅ MATCH TIME + DAY
        if (reminderTime == currentTime && reminderDays.indexOf(currentDay) >= 0) {
          reminderActive = true;
          reminderText = "Take Medicine!";
          break;
        }

        index = timeEnd;
      }
    }

    http.end();
  }
  void showReminder() {
    display.clearDisplay();
    display.setTextSize(2);
    display.setCursor(10, 10);
    display.println("REMINDER");

    display.setTextSize(1);
    display.setCursor(10, 40);
    display.println(reminderText);

    display.display();

  }
  void showRemindersPage() {
    struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return;

  char currentTime[6];
  strftime(currentTime, sizeof(currentTime), "%H:%M", &timeinfo);   
    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(20, 0);
    display.println("[ REMINDERS ]");

    display.drawLine(0, 10, 128, 10, SSD1306_WHITE);

    for (int i = 0; i < reminderCount && i < 4; i++) {
      display.setCursor(0, 14 + (i * 12));

      if (r_time[i] == currentTime) {
    display.print(">> ");
  }

  display.print(r_time[i]);
      display.print(" ");

      display.print("(");
      display.print(r_days[i]);
      display.print(")");
    }

    if (reminderCount == 0) {
      display.setCursor(10, 30);
      display.println("No reminders");
    }

    display.display();
  }