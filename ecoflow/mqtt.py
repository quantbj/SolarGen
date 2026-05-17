from __future__ import annotations

import os
import random
import socket
import ssl
import struct
import time
from typing import Callable

from .client import EcoFlowClient


DEFAULT_KEEPALIVE = 30


class MQTTError(RuntimeError):
    pass


class MQTTConnectionClosed(MQTTError):
    pass


class MinimalMQTTClient:
    """Small MQTT 3.1.1 subscriber for EcoFlow's quota topic."""

    def __init__(self, host: str, port: int, username: str, password: str, client_id: str, keepalive: int = DEFAULT_KEEPALIVE):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.client_id = client_id
        self.keepalive = keepalive
        self.sock: ssl.SSLSocket | None = None
        self.packet_id = 1

    def connect(self) -> None:
        raw_sock = socket.create_connection((self.host, self.port), timeout=30)
        context = ssl.create_default_context()
        self.sock = context.wrap_socket(raw_sock, server_hostname=self.host)
        self.sock.settimeout(max(5, min(15, self.keepalive / 2)))

        variable_header = encode_utf8("MQTT") + bytes([4, 0xC2]) + struct.pack("!H", self.keepalive)
        payload = encode_utf8(self.client_id) + encode_utf8(self.username) + encode_utf8(self.password)
        self._send_packet(0x10, variable_header + payload)
        packet_type, body = self._read_packet()
        if packet_type != 0x20 or len(body) < 2 or body[1] != 0:
            raise MQTTError(f"MQTT CONNACK failed: packet_type=0x{packet_type:02x} body={body!r}")

    def subscribe(self, topic: str, qos: int = 0) -> None:
        packet_id = self._next_packet_id()
        payload = struct.pack("!H", packet_id) + encode_utf8(topic) + bytes([qos])
        self._send_packet(0x82, payload)
        packet_type, body = self._read_packet()
        if packet_type != 0x90 or len(body) < 3 or body[-1] == 0x80:
            raise MQTTError(f"MQTT SUBACK failed for {topic}: packet_type=0x{packet_type:02x} body={body!r}")

    def loop_forever(self, on_message: Callable[[str, bytes], None], on_idle: Callable[[], None] | None = None) -> None:
        last_ping = time.monotonic()
        while True:
            try:
                packet_type, body = self._read_packet()
            except socket.timeout:
                packet_type, body = 0, b""

            if packet_type == 0:
                if on_idle:
                    on_idle()
                if time.monotonic() - last_ping >= self.keepalive / 2:
                    self._send_packet(0xC0, b"")
                    last_ping = time.monotonic()
                continue
            high_nibble = packet_type & 0xF0
            if high_nibble == 0x30:
                topic, payload, packet_id = decode_publish(packet_type, body)
                on_message(topic, payload)
                if packet_id is not None:
                    self._send_packet(0x40, struct.pack("!H", packet_id))
            elif packet_type == 0xD0:
                last_ping = time.monotonic()
            elif packet_type == 0xE0:
                raise MQTTConnectionClosed("Broker closed the MQTT connection.")

    def close(self) -> None:
        if self.sock:
            self.sock.close()
            self.sock = None

    def _send_packet(self, packet_type: int, body: bytes) -> None:
        if not self.sock:
            raise MQTTError("MQTT socket is not connected.")
        self.sock.sendall(bytes([packet_type]) + encode_remaining_length(len(body)) + body)

    def _read_packet(self) -> tuple[int, bytes]:
        if not self.sock:
            raise MQTTError("MQTT socket is not connected.")
        packet_type = read_exact(self.sock, 1)[0]
        remaining = decode_remaining_length_from_socket(self.sock)
        return packet_type, read_exact(self.sock, remaining)

    def _next_packet_id(self) -> int:
        value = self.packet_id
        self.packet_id = 1 if self.packet_id >= 65535 else self.packet_id + 1
        return value


def mqtt_certification(client: EcoFlowClient) -> dict:
    response = client.request("GET", "/iot-open/sign/certification")
    return response.get("data") or {}


def build_client_id(prefix: str) -> str:
    suffix = f"{os.getpid()}-{int(time.time())}-{random.randint(1000, 9999)}"
    return f"{prefix}-{suffix}"[:64]


def encode_utf8(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return struct.pack("!H", len(encoded)) + encoded


def encode_remaining_length(value: int) -> bytes:
    encoded = bytearray()
    while True:
        digit = value % 128
        value //= 128
        if value:
            digit |= 0x80
        encoded.append(digit)
        if not value:
            return bytes(encoded)


def decode_remaining_length_from_socket(sock: socket.socket) -> int:
    multiplier = 1
    value = 0
    for _ in range(4):
        digit = read_exact(sock, 1)[0]
        value += (digit & 127) * multiplier
        if not digit & 128:
            return value
        multiplier *= 128
    raise MQTTError("Malformed MQTT remaining length.")


def read_exact(sock: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sock.recv(length - len(chunks))
        if not chunk:
            raise MQTTConnectionClosed("MQTT socket closed.")
        chunks.extend(chunk)
    return bytes(chunks)


def decode_publish(packet_type: int, body: bytes) -> tuple[str, bytes, int | None]:
    if len(body) < 2:
        raise MQTTError("Malformed MQTT PUBLISH packet.")
    topic_len = struct.unpack("!H", body[:2])[0]
    topic_start = 2
    topic_end = topic_start + topic_len
    topic = body[topic_start:topic_end].decode("utf-8", errors="replace")
    qos = (packet_type & 0x06) >> 1
    packet_id = None
    payload_start = topic_end
    if qos:
        packet_id = struct.unpack("!H", body[payload_start:payload_start + 2])[0]
        payload_start += 2
    return topic, body[payload_start:], packet_id
