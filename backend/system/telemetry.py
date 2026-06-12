"""Live hardware telemetry — real readings from the host machine.

CPU/RAM via psutil; NVIDIA GPU via NVML (the same interface nvidia-smi
uses), so utilization, VRAM, temperature, and power draw are the actual
driver-reported numbers, not estimates. The frontend SystemMonitor
panel polls /api/v1/system/stats with this data.
"""

from __future__ import annotations

import logging
import platform
import threading
import time
from typing import Optional

import psutil

logger = logging.getLogger(__name__)

_nvml_lock = threading.Lock()
_nvml_initialized = False
_nvml_failed = False


def _ensure_nvml() -> bool:
    """Init NVML once; remember permanent failure (no NVIDIA driver)."""
    global _nvml_initialized, _nvml_failed
    if _nvml_initialized:
        return True
    if _nvml_failed:
        return False
    with _nvml_lock:
        if _nvml_initialized:
            return True
        try:
            import pynvml

            pynvml.nvmlInit()
            _nvml_initialized = True
            return True
        except Exception as exc:  # noqa: BLE001 — any NVML failure means no GPU telemetry
            logger.warning("NVML init failed, GPU telemetry disabled: %s", exc)
            _nvml_failed = True
            return False


def _cpu_marketing_name() -> str:
    """Human CPU name; Windows registry has it, platform.processor() doesn't."""
    if platform.system() == "Windows":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            ) as key:
                return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
        except OSError:
            pass
    return platform.processor()


def get_static_specs() -> dict:
    """One-time machine description (cache on the client)."""
    cpu_freq = psutil.cpu_freq()
    specs = {
        "os": f"{platform.system()} {platform.release()}",
        "cpu_name": _cpu_marketing_name(),
        "cpu_cores_physical": psutil.cpu_count(logical=False),
        "cpu_threads": psutil.cpu_count(logical=True),
        "cpu_max_mhz": round(cpu_freq.max) if cpu_freq else None,
        "ram_total_gb": round(psutil.virtual_memory().total / 2**30, 1),
        "gpu": None,
    }

    if _ensure_nvml():
        import pynvml

        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(handle)
        if isinstance(name, bytes):
            name = name.decode()
        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
        specs["gpu"] = {
            "name": name,
            "vram_total_gb": round(mem.total / 2**30, 1),
            "driver": pynvml.nvmlSystemGetDriverVersion(),
        }

    return specs


def get_live_stats() -> dict:
    """Instant snapshot: CPU %, RAM, and NVIDIA GPU load/VRAM/temp/power."""
    vm = psutil.virtual_memory()
    stats = {
        "ts": time.time(),
        "cpu_percent": psutil.cpu_percent(interval=None),
        "cpu_per_core": psutil.cpu_percent(interval=None, percpu=True),
        "ram_used_gb": round(vm.used / 2**30, 2),
        "ram_total_gb": round(vm.total / 2**30, 1),
        "ram_percent": vm.percent,
        "gpu": None,
    }

    if _ensure_nvml():
        import pynvml

        try:
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            try:
                power_w = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
            except pynvml.NVMLError:
                power_w = None
            try:
                power_limit_w = pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000.0
            except pynvml.NVMLError:
                power_limit_w = None

            stats["gpu"] = {
                "util_percent": util.gpu,
                "vram_used_gb": round(mem.used / 2**30, 2),
                "vram_total_gb": round(mem.total / 2**30, 1),
                "vram_percent": round(mem.used / mem.total * 100, 1),
                "temp_c": temp,
                "power_w": round(power_w, 1) if power_w is not None else None,
                "power_limit_w": round(power_limit_w, 1) if power_limit_w is not None else None,
            }
        except Exception as exc:  # noqa: BLE001 — transient NVML hiccup, return partial stats
            logger.debug("GPU stat read failed: %s", exc)

    return stats


# Warm up psutil's CPU sampling so the first request returns a real
# number instead of 0.0 (cpu_percent needs a prior call as baseline).
psutil.cpu_percent(interval=None)


if __name__ == "__main__":
    import json

    print(json.dumps(get_static_specs(), indent=2))
    time.sleep(0.5)
    print(json.dumps(get_live_stats(), indent=2))
