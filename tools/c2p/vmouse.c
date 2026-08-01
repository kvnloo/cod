/*
 * vmouse — a uinput virtual mouse that emits REAL kernel input events at a
 * paced rate and records, per event, the CLOCK_MONOTONIC instant the write(2)
 * to /dev/uinput returned.
 *
 * Why this exists: CDP Input.dispatchMouseEvent injects synthetic events
 * *inside the browser process*. It therefore cannot measure evdev -> libinput
 * -> compositor -> browser. A uinput device is indistinguishable from real
 * hardware to everything above the USB HID driver, so the only part of the
 * real path it omits is the mouse MCU + USB interrupt endpoint wait.
 *
 * dx cycles 1..MARK_MOD so a receiver can recover the emission index from the
 * delta value even if some events are dropped or merged.
 *
 * build: gcc -O2 -o vmouse vmouse.c
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <linux/uinput.h>

#define MARK_MOD 200

static long long now_ns(clockid_t c) {
    struct timespec ts;
    clock_gettime(c, &ts);
    return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static int emit(int fd, int type, int code, int val) {
    struct input_event ie;
    memset(&ie, 0, sizeof(ie));
    ie.type = type; ie.code = code; ie.value = val;
    return write(fd, &ie, sizeof(ie)) == sizeof(ie) ? 0 : -1;
}

int main(int argc, char **argv) {
    double rate = 1000.0;
    int count = 2000, warmup_ms = 1200, settle_ms = 250;
    const char *out = NULL;
    const char *mode = "move";   /* move | click | movetiny */
    int extra_delay_us = 0;      /* control: inject a known delay before write */

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--rate")) rate = atof(argv[++i]);
        else if (!strcmp(argv[i], "--count")) count = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--out")) out = argv[++i];
        else if (!strcmp(argv[i], "--mode")) mode = argv[++i];
        else if (!strcmp(argv[i], "--warmup-ms")) warmup_ms = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--settle-ms")) settle_ms = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--control-delay-us")) extra_delay_us = atoi(argv[++i]);
    }

    int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (fd < 0) { fprintf(stderr, "open /dev/uinput: %s\n", strerror(errno)); return 2; }

    ioctl(fd, UI_SET_EVBIT, EV_KEY);
    ioctl(fd, UI_SET_KEYBIT, BTN_LEFT);
    ioctl(fd, UI_SET_KEYBIT, BTN_RIGHT);
    ioctl(fd, UI_SET_KEYBIT, BTN_MIDDLE);
    ioctl(fd, UI_SET_EVBIT, EV_REL);
    ioctl(fd, UI_SET_RELBIT, REL_X);
    ioctl(fd, UI_SET_RELBIT, REL_Y);
    ioctl(fd, UI_SET_RELBIT, REL_WHEEL);

    struct uinput_setup us;
    memset(&us, 0, sizeof(us));
    us.id.bustype = BUS_USB;
    us.id.vendor  = 0xdead;
    us.id.product = 0xbeef;
    us.id.version = 1;
    strcpy(us.name, "c2p-vmouse");
    if (ioctl(fd, UI_DEV_SETUP, &us) < 0) { fprintf(stderr, "UI_DEV_SETUP: %s\n", strerror(errno)); return 2; }
    if (ioctl(fd, UI_DEV_CREATE) < 0)     { fprintf(stderr, "UI_DEV_CREATE: %s\n", strerror(errno)); return 2; }

    /* let udev + libinput + the compositor enumerate the device */
    struct timespec w = { warmup_ms / 1000, (long)(warmup_ms % 1000) * 1000000L };
    nanosleep(&w, NULL);

    if (!strcmp(mode, "daemon")) {
        char line[1024];
        setvbuf(stdout, NULL, _IOLBF, 0);
        printf("ready\n");
        while (fgets(line, sizeof(line), stdin)) {
            double r2; int c2, dly; char m2[32], of[512];
            if (sscanf(line, "%lf %d %31s %d %511s", &r2, &c2, m2, &dly, of) != 5) { printf("badcmd\n"); continue; }
            FILE *g = fopen(of, "w");
            if (!g) { printf("badfile\n"); continue; }
            long long pn = (long long)(1e9 / r2);
            long long b0 = now_ns(CLOCK_MONOTONIC);
            fprintf(g, "{\"kind\":\"anchor\",\"mono_ns\":%lld,\"real_ns\":%lld,\"rate\":%g,\"count\":%d,\"mode\":\"%s\",\"control_delay_us\":%d}\n",
                    b0, now_ns(CLOCK_REALTIME), r2, c2, m2, dly);
            for (int i = 0; i < c2; i++) {
                long long dl = b0 + (long long)(i + 1) * pn;
                struct timespec t2 = { dl / 1000000000LL, dl % 1000000000LL };
                clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &t2, NULL);
                long long a0 = now_ns(CLOCK_MONOTONIC);
                if (dly > 0) { struct timespec dd = { 0, (long)dly * 1000L }; nanosleep(&dd, NULL); }
                int dxx = (i % MARK_MOD) + 1;
                if (!strcmp(m2, "click")) { emit(fd, EV_KEY, BTN_LEFT, (i & 1) ? 0 : 1); emit(fd, EV_SYN, SYN_REPORT, 0); }
                else { emit(fd, EV_REL, REL_X, dxx); emit(fd, EV_SYN, SYN_REPORT, 0); }
                long long a1 = now_ns(CLOCK_MONOTONIC);
                fprintf(g, "{\"i\":%d,\"dx\":%d,\"t0\":%lld,\"t1\":%lld}\n", i, dxx, a0, a1);
            }
            fclose(g);
            printf("done\n");
        }
        ioctl(fd, UI_DEV_DESTROY); close(fd); return 0;
    }

    FILE *f = out ? fopen(out, "w") : stdout;
    if (!f) { fprintf(stderr, "open out\n"); return 2; }

    long long period_ns = (long long)(1e9 / rate);
    long long t0 = now_ns(CLOCK_MONOTONIC);
    /* clock-domain anchor so the browser (TimeTicks == CLOCK_MONOTONIC on Linux,
       performance.timeOrigin in CLOCK_REALTIME) can be aligned. */
    long long anchor_mono = now_ns(CLOCK_MONOTONIC);
    long long anchor_real = now_ns(CLOCK_REALTIME);
    fprintf(f, "{\"kind\":\"anchor\",\"mono_ns\":%lld,\"real_ns\":%lld,\"rate\":%g,\"count\":%d,\"mode\":\"%s\",\"control_delay_us\":%d}\n",
            anchor_mono, anchor_real, rate, count, mode, extra_delay_us);

    for (int i = 0; i < count; i++) {
        long long deadline = t0 + (long long)(i + 1) * period_ns;
        struct timespec ts = { deadline / 1000000000LL, deadline % 1000000000LL };
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL);

        /* t0 is the reference instant BEFORE any injected delay: the control
           test computes latency against t0 and must see exactly extra_delay_us
           more than the same computation against t1. */
        long long tw0 = now_ns(CLOCK_MONOTONIC);
        if (extra_delay_us > 0) {
            struct timespec d = { 0, (long)extra_delay_us * 1000L };
            nanosleep(&d, NULL);
        }

        int dx = (i % MARK_MOD) + 1;
        if (!strcmp(mode, "click")) {
            emit(fd, EV_KEY, BTN_LEFT, (i & 1) ? 0 : 1);
            emit(fd, EV_SYN, SYN_REPORT, 0);
        } else if (!strcmp(mode, "movetiny")) {
            emit(fd, EV_REL, REL_X, (i & 1) ? 1 : -1);
            emit(fd, EV_SYN, SYN_REPORT, 0);
            dx = (i & 1) ? 1 : -1;
        } else {
            emit(fd, EV_REL, REL_X, dx);
            emit(fd, EV_SYN, SYN_REPORT, 0);
        }
        long long tw1 = now_ns(CLOCK_MONOTONIC);
        fprintf(f, "{\"i\":%d,\"dx\":%d,\"t0\":%lld,\"t1\":%lld}\n", i, dx, tw0, tw1);
    }
    fflush(f);
    if (out) fclose(f);

    struct timespec s = { settle_ms / 1000, (long)(settle_ms % 1000) * 1000000L };
    nanosleep(&s, NULL);
    ioctl(fd, UI_DEV_DESTROY);
    close(fd);
    return 0;
}
