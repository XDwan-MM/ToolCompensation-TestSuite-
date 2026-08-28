/* ═══════════════════════════════════════════════════════════════
 * bench_comp — 刀补性能基准测试
 *
 * 用法: bench_comp -r <run_pmc_test路径> <有刀补.nc> <无刀补.nc> [D] [N]
 *   D: 刀补半径，默认 6.0
 *   N: 迭代次数，默认 100
 *
 * 编译: gcc -O2 -std=c99 -o bench_comp bench_comp.c
 * 依赖: 仅 POSIX C（fork/execvp/wait4/clock_gettime/getrusage）
 * ═══════════════════════════════════════════════════════════════ */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/stat.h>

/* ── 工具函数 ─────────────────────────────────────────────── */

static double timespec_to_double(struct timespec ts)
{
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static double timeval_to_double(struct timeval tv)
{
    return (double)tv.tv_sec + (double)tv.tv_usec / 1e6;
}

/* ── 单轮执行 ─────────────────────────────────────────────── */

/* 返回: wall-clock 耗时 (秒)，并通过 rusage 拿 CPU。 -1=fork/exec 失败, -2=子进程异常退出 */
static double run_one(const char *runner, const char *nc_file, double D,
                      double *user_cpu, double *sys_cpu)
{
    struct timespec t0, t1;
    if (clock_gettime(CLOCK_MONOTONIC, &t0) != 0) {
        perror("clock_gettime");
        return -1.0;
    }

    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return -1.0;
    }

    if (pid == 0) {
        /* 子进程：stdout/stderr → /dev/null */
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            dup2(devnull, STDOUT_FILENO);
            dup2(devnull, STDERR_FILENO);
            close(devnull);
        }

        char s_D[64], s_cnv[4], s_cav[4], s_naa[4], s_sup[4], s_suv[4], s_ccc[4];
        snprintf(s_D,   sizeof(s_D),   "%.3f", D);
        snprintf(s_cnv, sizeof(s_cnv), "0");
        snprintf(s_cav, sizeof(s_cav), "0");
        snprintf(s_naa, sizeof(s_naa), "0");
        snprintf(s_sup, sizeof(s_sup), "0");
        snprintf(s_suv, sizeof(s_suv), "0");
        snprintf(s_ccc, sizeof(s_ccc), "0");

        char *args[] = {
            (char *)runner,
            (char *)nc_file,
            s_D, s_cnv, s_cav, s_naa, s_sup, s_suv, s_ccc,
            (char *)"/dev/null",    /* output.json */
            (char *)"--bench",
            NULL
        };
        execvp(runner, args);
        _exit(127);
    }

    /* 父进程 */
    int status;
    struct rusage ru;
    pid_t w;
    do {
        w = wait4(pid, &status, 0, &ru);
    } while (w < 0 && errno == EINTR);

    if (clock_gettime(CLOCK_MONOTONIC, &t1) != 0) {
        perror("clock_gettime");
        return -1.0;
    }

    *user_cpu = timeval_to_double(ru.ru_utime);
    *sys_cpu  = timeval_to_double(ru.ru_stime);

    if (w < 0) {
        fprintf(stderr, "wait4 failed: %s\n", strerror(errno));
        return -1.0;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        return -2.0;
    }

    return timespec_to_double(t1) - timespec_to_double(t0);
}

/* ── 统计 ────────────────────────────────────────────────── */

static void compute_stats(const double *arr, int n,
                          double *min, double *max, double *avg, double *stddev)
{
    if (n == 0) {
        *min = *max = *avg = *stddev = 0.0;
        return;
    }
    double sum = 0.0;
    double mn = arr[0], mx = arr[0];
    for (int i = 0; i < n; i++) {
        sum += arr[i];
        if (arr[i] < mn) mn = arr[i];
        if (arr[i] > mx) mx = arr[i];
    }
    double mean = sum / n;
    double var = 0.0;
    for (int i = 0; i < n; i++) {
        double d = arr[i] - mean;
        var += d * d;
    }
    *min    = mn;
    *max    = mx;
    *avg    = mean;
    *stddev = sqrt(var / n);
}

/* ── 主流程 ──────────────────────────────────────────────── */

static int bench(const char *label, const char *runner,
                 const char *nc_file, double D, int N,
                 double *out_user, double *out_sys,
                 int *out_count, int *out_fail,
                 double *out_avg, double *out_min, double *out_max,
                 double *out_stddev, double *out_wall_total)
{
    /* 预热 3 轮（不计入统计） */
    for (int i = 0; i < 3; i++) {
        double uc, sc;
        run_one(runner, nc_file, D, &uc, &sc);
    }

    double *walls = (double *)malloc((size_t)N * sizeof(double));
    if (!walls) { perror("malloc"); return -1; }

    double user_total = 0.0, sys_total = 0.0, wall_total = 0.0;
    int count = 0, fail = 0;

    for (int i = 0; i < N; i++) {
        double uc = 0.0, sc = 0.0;
        double w = run_one(runner, nc_file, D, &uc, &sc);

        if (w < 0.0) {
            fail++;
            if (w == -2.0) {
                fprintf(stderr, "  [%s] round %d: child exited abnormally\n", label, i + 1);
            }
            continue;
        }

        walls[count] = w;
        user_total += uc;
        sys_total  += sc;
        wall_total += w;
        count++;

        if ((i + 1) % 50 == 0) {
            fprintf(stderr, "  [%s] %d/%d ...\n", label, i + 1, N);
        }
    }

    compute_stats(walls, count, out_min, out_max, out_avg, out_stddev);
    *out_user       = user_total;
    *out_sys        = sys_total;
    *out_count      = count;
    *out_fail       = fail;
    *out_wall_total = wall_total;
    free(walls);
    return 0;
}

/* ─────────────────────────────────────────────────────────── */

int main(int argc, char *argv[])
{
    const char *runner = NULL;
    int opt;

    while ((opt = getopt(argc, argv, "r:")) != -1) {
        switch (opt) {
        case 'r': runner = optarg; break;
        default:
            fprintf(stderr, "Usage: %s -r <runner> <nc_comp> <nc_nocomp> [D] [N]\n", argv[0]);
            return 1;
        }
    }

    if (!runner || argc - optind < 2) {
        fprintf(stderr, "Usage: %s -r <runner> <nc_comp> <nc_nocomp> [D] [N]\n", argv[0]);
        return 1;
    }

    const char *nc_comp   = argv[optind];
    const char *nc_nocomp = argv[optind + 1];
    double D = (argc - optind >= 3) ? atof(argv[optind + 2]) : 6.0;
    int    N = (argc - optind >= 4) ? atoi(argv[optind + 3]) : 100;

    if (N < 1) { fprintf(stderr, "N must be >= 1\n"); return 1; }

    if (access(runner, X_OK) != 0) {
        fprintf(stderr, "Error: runner not found or not executable: %s\n", runner);
        return 1;
    }
    if (access(nc_comp, R_OK) != 0) {
        fprintf(stderr, "Error: cannot read %s\n", nc_comp); return 1;
    }
    if (access(nc_nocomp, R_OK) != 0) {
        fprintf(stderr, "Error: cannot read %s\n", nc_nocomp); return 1;
    }

    printf("═══════════════════════════════════════\n");
    printf("  Tool Comp Benchmark\n");
    printf("═══════════════════════════════════════\n");
    printf("  runner  : %s\n", runner);
    printf("  comp NC : %s\n", nc_comp);
    printf("  plain NC: %s\n", nc_nocomp);
    printf("  D=%.2f  N=%d\n", D, N);
    printf("═══════════════════════════════════════\n\n");

    /* 有刀补 */
    double cu, cs, c_avg, c_min, c_max, c_std, c_wall;
    int cc, cf;
    if (bench("comp", runner, nc_comp, D, N, &cu, &cs, &cc, &cf,
              &c_avg, &c_min, &c_max, &c_std, &c_wall) != 0)
        return 1;

    /* 无刀补 */
    double nu, ns, n_avg, n_min, n_max, n_std, n_wall;
    int nc2, nf;
    if (bench("plain", runner, nc_nocomp, D, N, &nu, &ns, &nc2, &nf,
              &n_avg, &n_min, &n_max, &n_std, &n_wall) != 0)
        return 1;

    printf("\n═══════════════════════════════════════\n");
    printf("  Results\n");
    printf("═══════════════════════════════════════\n");

    double c_cpu = (c_wall > 0.0) ? (cu + cs) / c_wall * 100.0 : 0.0;
    double n_cpu = (n_wall > 0.0) ? (nu + ns) / n_wall * 100.0 : 0.0;

    printf("  comp : ok %d/%d  avg %.4fs  min %.4fs  max %.4fs  sd=%.4fs  CPU %.1f%%\n",
           cc, cc + cf, c_avg, c_min, c_max, c_std, c_cpu);
    printf("  plain: ok %d/%d  avg %.4fs  min %.4fs  max %.4fs  sd=%.4fs  CPU %.1f%%\n",
           nc2, nc2 + nf, n_avg, n_min, n_max, n_std, n_cpu);

    if (cc > 0 && nc2 > 0) {
        double overhead = c_avg - n_avg;
        double ratio    = (n_avg > 0.0) ? (c_avg / n_avg - 1.0) * 100.0 : 0.0;
        printf("  ─────────────────────────────────────\n");
        printf("  overhead: %.4fs (%.0f%%)\n", overhead, ratio);
    } else {
        printf("  Cannot compare (not enough valid rounds)\n");
    }

    printf("═══════════════════════════════════════\n");
    return 0;
}
